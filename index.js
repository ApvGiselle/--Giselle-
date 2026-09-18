(async function () {
    // 获取宿主环境 document
    let targetDoc = document;
    let targetWin = window;
    try {
        if (
            window.parent &&
            window.parent !== window &&
            window.parent.document &&
            window.parent.innerWidth > 0 &&
            window.parent.innerHeight > 0
        ) {
            targetDoc = window.parent.document;
            targetWin = window.parent;
        }
    } catch (e) {
        console.warn("[АрⅤ] 跨域限制，降级至当前环境。");
    }

    // ================= 核心配置 =================
    const CONFIG = {
        ID: 'st-flow-music-player-pro',
        Z_INDEX: 2147483640,
        SAFE_MARGIN: 20, // 增加安全边距，防止贴边太紧
        DEFAULT_THEME: 'adaptive',
        STORAGE_KEY: 'apv_terminal_playlist_data',
        SETTINGS_KEY: 'apv_terminal_settings',
        MAX_TRACKS_PER_LIST: 1000 // 防卡死：单列表最大歌曲数
    };

    // 尝试读取本地存储的歌单
    let savedPlaylists = [{ id: 'default', name: '默认列表', tracks: [] }];
    try {
        const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
        if (saved) {
            const parsed = JSON.parse(saved);
            if (Array.isArray(parsed)) {
                if (parsed.length > 0 && parsed[0].tracks) {
                    savedPlaylists = parsed;
                } else {
                    savedPlaylists[0].tracks = parsed;
                }
            }
        }
    } catch (e) { console.warn("读取本地歌单失败", e); }

    // 容错：避免损坏的本地数据导致初始化阶段直接崩溃。
    savedPlaylists = Array.isArray(savedPlaylists) ? savedPlaylists
        .filter(p => p && typeof p === 'object')
        .map((p, i) => ({
            id: String(p.id || (i === 0 ? 'default' : `pl_${Date.now()}_${i}`)),
            name: String(p.name || (i === 0 ? '默认列表' : `歌单 ${i + 1}`)),
            tracks: Array.isArray(p.tracks) ? p.tracks.filter(Boolean) : []
        })) : [];
    if (!savedPlaylists.length || savedPlaylists[0].id !== 'default') {
        savedPlaylists.unshift({ id: 'default', name: '默认列表', tracks: [] });
    }

    // 防卡死：严格去重与容量限制
    function trackDedupeKey(t) {
        const idPart = t.rawId || t.lyricId || '';
        return `${t.source || ''}::${idPart}::${(t.title || '').trim()}::${(t.artist || '').trim()}`.toLowerCase();
    }

    // API/本地数据可能包含 HTML 特殊字符；渲染前统一转义，避免破坏播放器 DOM。
    function escapeHTML(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    
    function dedupeAndLimitTracks(tracks) {
        const seen = new Set();
        const result = [];
        for (const t of tracks) {
            if (result.length >= CONFIG.MAX_TRACKS_PER_LIST) break; // 触发容量限制
            const key = trackDedupeKey(t);
            if (seen.has(key)) continue;
            seen.add(key);
            result.push(t);
        }
        return result;
    }

    let startupDedupeCount = 0;
    let startupLimitCount = 0;
    savedPlaylists.forEach(list => {
        const before = list.tracks.length;
        list.tracks = dedupeAndLimitTracks(list.tracks);
        const removed = before - list.tracks.length;
        if (removed > 0) {
            if (before > CONFIG.MAX_TRACKS_PER_LIST) {
                startupLimitCount += (before - CONFIG.MAX_TRACKS_PER_LIST);
                startupDedupeCount += (removed - (before - CONFIG.MAX_TRACKS_PER_LIST));
            } else {
                startupDedupeCount += removed;
            }
        }
    });
    
    if (startupDedupeCount > 0 || startupLimitCount > 0) {
        try { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(savedPlaylists)); } catch (e) {}
    }

    // 读取本地设置
    let savedSettings = { 
        ballSize: 50, customColor: '#4a90e2', bgImage: '', bgImageWidth: 0, bgImageHeight: 0, 
        bgBlur: 10, bgBrightness: 70, lrcMode: 'popup', lrcFont: 16, lrcBottom: 80, 
        panelRatio: 'default', shapeStyle: 'round', theme: 'adaptive',
        nowCoverImage: '', nowPlayingLabel: 'NOW PLAYING', showBall: true
    };
    try {
        const s = localStorage.getItem(CONFIG.SETTINGS_KEY);
        if (s) savedSettings = { ...savedSettings, ...JSON.parse(s) };
    } catch(e) {}
    // 旧版本的字体设置仅作兼容清理，不再参与任何功能。
    delete savedSettings.customFont;

    // ================= 状态管理 =================
    const STATE = {
        isVisible: true,
        isExpanded: false,
        isPlaying: false,
        currentTheme: savedSettings.theme || CONFIG.DEFAULT_THEME,
        playMode: 'repeat_all',
        playlists: savedPlaylists,
        currentPlaylistId: savedPlaylists[0].id,
        playingPlaylistId: savedPlaylists[0].id,
        searchResults: [],
        currentInputMode: 'netease',
        isShowingSearch: false, 
        localSearchKeyword: '', 
        currentIndex: -1,
        lyricsData: [],
        isLyricsVisible: true,
        lastActiveLrcIndex: -1,
        isSeekingProgress: false,
        playRequestId: 0
    };

    const getCurrentPlaylist = () => STATE.playlists.find(p => p.id === STATE.currentPlaylistId) || STATE.playlists[0];
    const getPlayingPlaylist = () => STATE.playlists.find(p => p.id === STATE.playingPlaylistId) || STATE.playlists[0];

    let audio = new targetWin.Audio();
    let lrcRafId = null;

    // ================= API 封装 =================
    const API = {
        toast(msg) {
            if (typeof triggerSlash === 'function') {
                const safeMsg = msg.replace(/(\\+)?([|{}])/g, (m, s, c) => (s || '') + (s || '') + '\\' + c);
                triggerSlash(`/echo severity=info [АрⅤ终端] ${safeMsg}`);
            } else {
                console.log(`[АрⅤ终端] ${msg}`);
            }
        },
        _extractArray(data) {
            if (Array.isArray(data)) return data;
            if (data && typeof data === 'object') {
                if (Array.isArray(data.data)) return data.data;
                if (Array.isArray(data.list)) return data.list;
                if (data.data && Array.isArray(data.data.list)) return data.data.list;
                if (data.url || data.title || data.name) return [data];
            }
            return [];
        },
        _mapTrack(t, source) {
            const idFromUrl = (t.url || t.lrc || t.pic || '').match(/[?&]id=([^&]+)/);
            const extractedId = idFromUrl ? decodeURIComponent(idFromUrl[1]) : '';
            return {
                title: t.name || t.title || t.songName || '未知歌曲',
                artist: t.artist || t.author || t.singer || (Array.isArray(t.ar) ? t.ar.map(a=>a.name).join('/') : '未知歌手'),
                rawId: t.id || t.songId || t.mid || extractedId || '',
                lyricId: t.lyric_id || t.lyricId || t.id || t.songId || t.mid || extractedId || '',
                lrcUrl: t.lrc || null, 
                url: t.url || t.src || t.playUrl || null, 
                pic: t.pic || t.cover || t.img || null,
                source: source
            };
        },
        async _fetchJson(rawUrl, isUsable = data => data != null) {
            try {
                const res = await fetch(rawUrl);
                const data = await res.json();
                if (isUsable(data)) return data;
            } catch (e) {}
            const res = await fetch(`https://corsproxy.io/?${encodeURIComponent(rawUrl)}`);
            return await res.json();
        },
        async parsePlaylist(inputVal, source) {
            try {
                const idMatch = inputVal.match(/id=(\d+)/i) || inputVal.match(/\/(\d+)(?:\?|$)/);
                const targetId = idMatch ? idMatch[1] : inputVal;
                const rawUrl = `https://api.injahow.cn/meting/?server=${source}&type=playlist&id=${targetId}`;
                const data = await this._fetchJson(rawUrl, data => this._extractArray(data).length > 0);
                return this._extractArray(data).map(t => this._mapTrack(t, source));
            } catch (e) {
                return [];
            }
        },
        async searchTrack(keyword) {
            const safeKeyword = encodeURIComponent(keyword.trim());
            const rawUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${safeKeyword}&count=15&pages=1`;
            try {
                const data = await this._fetchJson(rawUrl, data => Array.isArray(data) && data.length > 0);
                return Array.isArray(data) ? data.map(t => ({
                    title: t.name,
                    artist: Array.isArray(t.artist) ? t.artist.join('/') : t.artist,
                    id: t.id,
                    lyricId: t.lyric_id || t.id,
                    source: t.source || 'netease'
                })) : [];
            } catch (e) {
                return [];
            }
        },
        async fillTrackInfo(title, artist) {
            const keyword = encodeURIComponent(`${title} ${artist}`.trim());
            const rawUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=netease&name=${keyword}&count=1&pages=1`;
            try {
                const data = await this._fetchJson(rawUrl, data => Array.isArray(data) && data.length > 0);
                return Array.isArray(data) && data.length > 0 ? data[0] : null;
            } catch (e) {
                return null;
            }
        },
        async getUrl(source, id) {
            const rawUrl = `https://music-api.gdstudio.xyz/api.php?types=url&source=${source}&id=${id}&br=320`;
            try {
                const data = await this._fetchJson(rawUrl, data => !!data?.url);
                return data?.url || null;
            } catch (e) {
                return null;
            }
        },
        async getLyric(source, id) {
            const rawUrl = `https://music-api.gdstudio.xyz/api.php?types=lyric&source=${source}&id=${id}`;
            try {
                return await this._fetchJson(rawUrl, data => !!data?.lyric);
            } catch (e) {
                return { __error: e.message || String(e) };
            }
        },
        async getLyricByUrl(url) {
            try {
                return await this._fetchJson(url, data => !!data?.lyric);
            } catch (e) {
                return { __error: e.message || String(e) };
            }
        }
    };

    // 防卡死：保存歌单时捕获异常
    const savePlaylist = () => {
        try {
            localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(STATE.playlists, (key, value) => {
                if (key === '__retriedOnError') return undefined;
                return value;
            }));
        } catch (e) { 
            console.warn("保存歌单失败", e); 
            if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                API.toast("⚠️ 存储空间已满！请清理不必要的歌单或歌曲，以防脚本卡死。");
            }
        }
    };

    // ================= UI 构建 =================
    const oldContainer = targetDoc.getElementById(CONFIG.ID);
    if (oldContainer) oldContainer.remove();

    const container = targetDoc.createElement('div');
    container.id = CONFIG.ID;
    container.style.cssText = `
        position: fixed; top: 0; left: 0;
        width: 100%; height: 100dvh;
        min-width: 100%; min-height: 100dvh;
        overflow: visible; pointer-events: none; z-index: ${CONFIG.Z_INDEX};
    `;
    targetDoc.body.appendChild(container);

    const shadow = container.attachShadow({ mode: 'open' });

    const faLink = targetDoc.createElement('link');
    faLink.rel = 'stylesheet';
    faLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
    shadow.appendChild(faLink);

    const style = targetDoc.createElement('style');
    style.textContent = `
        :host {
            all: initial;
            --fm-radius-ball: 50%;
            --fm-radius-panel: 24px;
            --fm-radius-btn: 50%;
            --fm-radius-input: 8px;
            --fm-radius-thumb: 50%;
            --fm-transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
            --fm-font: 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif;
        }

        .theme-adaptive { --fm-bg: var(--SmartThemeBlurTintColor, rgba(30, 30, 30, 0.85)); --fm-text-main: var(--SmartThemeBodyColor, #ffffff); --fm-text-sub: var(--SmartThemeEmColor, #aaaaaa); --fm-accent: var(--SmartThemeQuoteColor, #4a90e2); --fm-border: var(--SmartThemeBorderColor, rgba(255, 255, 255, 0.1)); --fm-shadow: var(--SmartThemeShadowColor, rgba(0, 0, 0, 0.3)); }
        .theme-light { --fm-bg: rgba(255, 255, 255, 0.9); --fm-text-main: #1a1a1a; --fm-text-sub: #7a7a7a; --fm-accent: #000000; --fm-border: rgba(0, 0, 0, 0.08); --fm-shadow: rgba(0, 0, 0, 0.1); }
        .theme-dark { --fm-bg: rgba(20, 20, 20, 0.9); --fm-text-main: #f0f0f0; --fm-text-sub: #888888; --fm-accent: #ffffff; --fm-border: rgba(255, 255, 255, 0.08); --fm-shadow: rgba(0, 0, 0, 0.4); }
        .theme-glass { --fm-bg: rgba(255, 255, 255, 0.1); --fm-text-main: #ffffff; --fm-text-sub: rgba(255,255,255,0.7); --fm-accent: var(--fm-custom-color, #ffffff); --fm-border: rgba(255, 255, 255, 0.2); --fm-shadow: rgba(0, 0, 0, 0.2); }

        * { box-sizing: border-box; font-family: var(--fm-font); margin: 0; padding: 0; }

        .fm-ball {
            position: absolute; width: var(--fm-ball-size, 50px); height: var(--fm-ball-size, 50px); 
            border-radius: var(--fm-radius-ball);
            background: var(--fm-bg); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
            border: 1px solid var(--fm-border); box-shadow: 0 4px 12px var(--fm-shadow);
            display: flex; justify-content: center; align-items: center;
            color: var(--fm-text-main); font-size: 20px; cursor: grab; pointer-events: auto;
            transition: var(--fm-transition); touch-action: none; user-select: none; z-index: 10;
        }
        .fm-ball:active { cursor: grabbing; transform: scale(0.95); }
        .fm-ball.playing { animation: breathe 3s ease-in-out infinite; }
        @keyframes breathe {
            0%, 100% { box-shadow: 0 0 8px var(--fm-shadow), 0 0 0 0 rgba(255,255,255,0); transform: scale(1); }
            50% { box-shadow: 0 0 16px var(--fm-shadow), 0 0 0 6px var(--fm-border); transform: scale(1.02); }
        }

        .fm-panel {
            position: absolute; 
            width: clamp(300px, 90vw, 400px);
            max-width: calc(100vw - 40px);
            height: var(--fm-panel-height, 540px);
            max-height: calc(100dvh - 40px);
            background: var(--fm-bg); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid var(--fm-border); 
            border-radius: var(--fm-radius-panel);
            box-shadow: 0 10px 30px var(--fm-shadow); display: flex; flex-direction: column;
            opacity: 0; transform: scale(0.8) translateY(20px); pointer-events: none;
            transition: var(--fm-transition); z-index: 5; overflow: hidden;
        }
        .fm-panel.open { opacity: 1; transform: scale(1) translateY(0); pointer-events: auto; }

        .fm-header { display: flex; align-items: center; padding: 16px 20px; border-bottom: 1px solid var(--fm-border); cursor: move; }
        .fm-cover-mock { width: 44px; height: 44px; border-radius: var(--fm-radius-btn); background: var(--fm-border); display: flex; justify-content: center; align-items: center; color: var(--fm-text-sub); font-size: 18px; margin-right: 12px; flex-shrink: 0; transition: var(--fm-transition); }
        .fm-info { flex: 1; overflow: hidden; }
        .fm-title { color: var(--fm-text-main); font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
        .fm-artist { color: var(--fm-text-sub); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fm-close-btn { background: none; border: none; color: var(--fm-text-sub); font-size: 18px; cursor: pointer; padding: 4px; transition: color 0.2s; }
        .fm-close-btn:hover { color: var(--fm-text-main); }

        .fm-progress-wrap { padding: 14px 20px 0; }
        .fm-progress-track { position: relative; height: 4px; border-radius: 2px; background: var(--fm-border); cursor: pointer; touch-action: none; padding: 8px 0; background-clip: content-box; box-sizing: content-box; }
        .fm-progress-fill { position: absolute; left: 0; top: 8px; height: 4px; border-radius: 2px; background: var(--fm-accent); width: 0%; pointer-events: none; }
        .fm-progress-thumb { position: absolute; top: 50%; left: 0%; width: 12px; height: 12px; border-radius: var(--fm-radius-thumb); background: var(--fm-text-main); box-shadow: 0 1px 4px rgba(0,0,0,0.3); transform: translate(-50%, -50%); pointer-events: none; transition: transform 0.15s, border-radius 0.4s; }
        .fm-progress-track:active .fm-progress-thumb, .fm-progress-track.dragging .fm-progress-thumb { transform: translate(-50%, -50%) scale(1.25); }
        .fm-time-row { display: flex; justify-content: space-between; font-size: 10px; color: var(--fm-text-sub); margin-top: 2px; }

        .fm-controls { display: flex; justify-content: space-between; align-items: center; padding: 12px 24px; }
        .fm-btn { background: none; border: none; color: var(--fm-text-main); font-size: 16px; cursor: pointer; transition: transform 0.2s, color 0.2s, border-radius 0.4s, background 0.2s; display: flex; justify-content: center; align-items: center; width: 32px; height: 32px; border-radius: var(--fm-radius-btn); }
        .fm-btn:hover { background: var(--fm-border); transform: scale(1.1); }
        .fm-btn:active { transform: scale(0.9); }
        .fm-btn.play-pause { font-size: 20px; width: 40px; height: 40px; background: var(--fm-text-main); color: var(--fm-bg); }
        .fm-btn.play-pause:hover { background: var(--fm-accent); color: #fff; }
        .fm-btn.active-state { color: var(--fm-accent); }

        .fm-list-section { display: flex; flex-direction: column; flex: 0 0 auto; min-height: 150px; border-top: 0; background: transparent; overflow: visible; }
        
        .fm-input-wrap { display: flex; padding: 4px 0; border-bottom: 0; gap: 6px; align-items: center; }
        .fm-select { background: rgba(0,0,0,0.1); border: 1px solid var(--fm-border); border-radius: var(--fm-radius-input); color: var(--fm-text-main); font-size: 12px; padding: 6px 4px; outline: none; cursor: pointer; transition: var(--fm-transition); }
        .fm-select option { background: #333; color: #fff; }
        .fm-input { flex: 1; background: transparent; border: 1px solid var(--fm-border); border-radius: var(--fm-radius-input); padding: 6px 10px; color: var(--fm-text-main); font-size: 12px; outline: none; transition: border-color 0.2s, border-radius 0.4s; }
        .fm-input:focus { border-color: var(--fm-accent); }
        .fm-input::placeholder { color: var(--fm-text-sub); opacity: 0.6; }
        .fm-add-btn { background: var(--fm-text-main); color: var(--fm-bg); border: none; border-radius: var(--fm-radius-input); padding: 6px 12px; cursor: pointer; font-weight: bold; font-size: 12px; transition: opacity 0.2s, border-radius 0.4s; }
        .fm-add-btn:hover { opacity: 0.8; }
        .fm-add-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .fm-playlist-tabs { display: flex; align-items: center; overflow-x: auto; padding: 6px 0; gap: 6px; border-bottom: 0; background: transparent; }
        .fm-playlist-tabs::-webkit-scrollbar { height: 0px; display: none; }
        .fm-playlist-tabs { touch-action: pan-x; -webkit-overflow-scrolling: touch; }
        .fm-tab { padding: 4px 12px; border-radius: var(--fm-radius-input); font-size: 11px; color: var(--fm-text-sub); background: transparent; border: 1px solid transparent; cursor: pointer; white-space: nowrap; transition: var(--fm-transition); user-select: none; }
        .fm-tab:hover { color: var(--fm-text-main); background: rgba(255,255,255,0.05); }
        .fm-tab.active { color: var(--fm-accent); background: rgba(0, 210, 255, 0.1); border-color: var(--fm-accent); font-weight: bold; }
        .fm-tab-del { margin-left: 6px; font-size: 10px; opacity: 0.5; transition: opacity 0.2s; }
        .fm-tab-del:hover { opacity: 1; color: #ff4d4f; }
        .fm-tab-add { padding: 4px 8px; border-radius: var(--fm-radius-input); font-size: 12px; color: var(--fm-text-sub); cursor: pointer; transition: var(--fm-transition); display: flex; align-items: center; }
        .fm-tab-add:hover { color: var(--fm-accent); background: rgba(255,255,255,0.1); }

        /* 修复下拉菜单越界问题：移至顶层并使用 fixed 绝对定位 */
        .fm-pop-menu {
            position: fixed; background: var(--fm-bg); border: 1px solid var(--fm-border);
            border-radius: var(--fm-radius-input); box-shadow: 0 4px 15px var(--fm-shadow); padding: 4px 0;
            z-index: 2147483647; min-width: 120px; max-height: 200px; overflow-y: auto; backdrop-filter: blur(10px);
            opacity: 0; transform: translateY(10px); pointer-events: none; transition: opacity 0.2s, transform 0.2s, border-radius 0.4s;
        }
        .fm-pop-menu::-webkit-scrollbar { width: 4px; }
        .fm-pop-menu::-webkit-scrollbar-thumb { background: var(--fm-border); border-radius: 2px; }
        .fm-pop-menu.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .fm-pop-item { padding: 8px 16px; font-size: 12px; color: var(--fm-text-main); cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 0.2s; }
        .fm-pop-item:hover { background: var(--fm-accent); color: #fff; }

        .fm-playlist { flex: 0 0 auto; overflow: visible; padding: 4px 0; position: relative; }
        .fm-playlist::-webkit-scrollbar { width: 4px; }
        .fm-playlist::-webkit-scrollbar-thumb { background: var(--fm-border); border-radius: 2px; }
        
        .fm-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 16px; cursor: pointer; transition: background 0.2s; }
        .fm-item:hover { background: var(--fm-border); }
        .fm-item.active { background: var(--fm-border); border-left: 3px solid var(--fm-accent); }
        .fm-item-info { flex: 1; overflow: hidden; display: flex; flex-direction: column; gap: 2px; }
        .fm-item-title { color: var(--fm-text-main); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .fm-item-artist { color: var(--fm-text-sub); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        
        .fm-item-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
        .fm-icon-btn { color: var(--fm-text-sub); background: none; border: none; cursor: pointer; padding: 4px; opacity: 0; transition: all 0.2s; font-size: 14px; }
        .fm-item:hover .fm-icon-btn { opacity: 1; }
        .fm-icon-btn:hover { color: var(--fm-accent); transform: scale(1.1); }
        .fm-icon-btn.del:hover { color: #ff4d4f; }
        .fm-icon-btn.pinned { color: var(--fm-accent); opacity: 1; }

        .fm-search-header { padding: 4px 16px; font-size: 11px; color: var(--fm-accent); background: rgba(0,0,0,0.2); display: flex; justify-content: space-between; align-items: center; }
        .fm-back-list, .fm-clear-list { cursor: pointer; text-decoration: underline; transition: opacity 0.2s; }
        .fm-clear-list:hover { opacity: 0.7; color: #ff4d4f; }

        .fm-theme-bar { display: flex; justify-content: space-around; padding: 10px; border-top: 1px solid var(--fm-border); }
        .fm-theme-dot { width: 16px; height: 16px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: transform 0.2s; }
        .fm-theme-dot:hover { transform: scale(1.2); }
        .fm-theme-dot.active { border-color: var(--fm-text-main); transform: scale(1.1); }
        .dot-adaptive { background: linear-gradient(45deg, #4a90e2, #50e3c2); }
        .dot-light { background: #f0f0f0; border-color: #ccc; }
        .dot-dark { background: #222; }
        .dot-glass { background: rgba(255,255,255,0.3); border-color: rgba(255,255,255,0.8); backdrop-filter: blur(4px); }

        /* 优化歌词动画：延长持续时间，调整缓动函数，使其更柔和 */
        
        .fm-panel-bg {
            position: absolute; top: -10%; left: -10%; width: 120%; height: 120%; z-index: -1;
            background-size: cover; background-position: center; background-repeat: no-repeat;
            pointer-events: none; transition: filter 0.3s;
            background-image: var(--fm-bg-image, none);
            filter: blur(var(--fm-bg-blur, 0px)) brightness(var(--fm-bg-brightness, 100%));
        }

        .fm-bg-btn { background: var(--fm-border); color: var(--fm-text-main); border: none; border-radius: var(--fm-radius-input); padding: 4px 8px; font-size: 11px; cursor: pointer; transition: var(--fm-transition); display: flex; align-items: center; gap: 4px; white-space: nowrap; }
        .fm-bg-btn:hover { background: var(--fm-accent); color: #fff; }
        .fm-bg-sliders { display: flex; flex: 1; align-items: center; gap: 10px; min-width: 120px; }
        .fm-bg-slider-wrap { display: flex; align-items: center; gap: 4px; flex: 1; font-size: 10px; color: var(--fm-text-sub); }
        .fm-bg-slider { flex: 1; height: 4px; -webkit-appearance: none; background: var(--fm-border); border-radius: 2px; outline: none; }
        .fm-bg-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 10px; height: 10px; border-radius: var(--fm-radius-thumb); background: var(--fm-text-main); cursor: pointer; transition: var(--fm-transition); }
        
        .fm-panel-bg {
            position: absolute; top: -10%; left: -10%; width: 120%; height: 120%; z-index: -1;
            background-size: cover; background-position: center; background-repeat: no-repeat;
            pointer-events: none; transition: filter 0.3s;
            background-image: var(--fm-bg-image, none);
            filter: blur(var(--fm-bg-blur, 0px)) brightness(var(--fm-bg-brightness, 100%));
        }

        .fm-out-lyrics {
            position: absolute;
            bottom: calc(var(--fm-lrc-bottom, 80px) + env(safe-area-inset-bottom, 0px));
            max-height: 40dvh; overflow: hidden; left: 50%; transform: translateX(-50%);
            width: max-content; max-width: 80vw; min-width: 60px; min-height: 24px;
            text-align: center; pointer-events: none; z-index: 2147483647;
            display: flex; flex-direction: column; align-items: center; gap: 4px;
            opacity: 0; transition: opacity 0.5s, bottom 0.2s;
        }
        .fm-out-lyrics.show { opacity: 1; }
        .fm-lrc-line { font-size: var(--fm-lrc-font, 16px); font-weight: bold; color: var(--fm-accent); text-shadow: 0 2px 8px var(--fm-shadow), 0 0 2px rgba(0,0,0,0.5); line-height: 1.4; }
        .fm-lrc-plain-line { font-size: var(--fm-lrc-font, 16px); font-weight: bold; color: var(--fm-accent); line-height: 1.4; text-shadow: 0 2px 8px var(--fm-shadow), 0 0 2px rgba(0,0,0,0.5); }
        .fm-lrc-plain-trans { margin-top: 4px; }
        .fm-lrc-trans { font-size: calc(var(--fm-lrc-font, 16px) * 0.75); color: var(--fm-text-sub); text-shadow: 0 1px 4px var(--fm-shadow); }
        
        /* 优化动画效果：减小位移，延长持续时间，增强“浮现”感而非“弹跳”感 */
        .lrc-anim-char { 
            display: inline-block; opacity: 0; transform: translateY(4px); 
            animation: lrc-in 1.0s cubic-bezier(0.22, 1, 0.36, 1) forwards; 
        }
        @keyframes lrc-in { to { opacity: 1; transform: translateY(0); } }

        /* 新增：随机掉落动画与标红样式 */
        .lrc-anim-fall {
            display: inline-block; opacity: 0; transform: translateY(-40px);
            /* 缩短基础动画时间，使其更干脆，避免拖沓 */
            animation: lrc-fall-in 0.8s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes lrc-fall-in { 
            0% { opacity: 0; transform: translateY(-40px); filter: blur(4px); }
            100% { opacity: 1; transform: translateY(0); filter: blur(0); } 
        }
        /* 翻译专用渐现动画：无位移，仅透明度和模糊变化 */
        .lrc-trans-fade {
            opacity: 0;
            animation: lrc-trans-fade-in 0.8s cubic-bezier(0.22, 1, 0.36, 1) forwards;
        }
        @keyframes lrc-trans-fade-in {
            0% { opacity: 0; filter: blur(4px); }
            100% { opacity: 1; filter: blur(0); }
        }
        /* 优化退场动画：原地模糊消散，更自然柔和 */
        @keyframes lrc-fade-out {
            0% { opacity: 1; transform: scale(1); filter: blur(0); }
            100% { opacity: 0; transform: scale(0.95); filter: blur(8px); }
        }
        .lrc-highlight {
            color: #ff4d4f !important;
            text-shadow: 0 0 8px rgba(255, 77, 79, 0.6), 0 2px 4px rgba(0,0,0,0.5) !important;
        }

        .fm-out-lyrics-scroll {
            position: absolute;
            bottom: calc(var(--fm-lrc-bottom, 80px) + env(safe-area-inset-bottom, 0px));
            max-height: 40dvh; overflow: hidden; left: 50%; transform: translateX(-50%);
            width: max-content; max-width: 80vw; min-width: 60px;
            height: calc(var(--fm-lrc-font, 16px) * 5.4);
            overflow: hidden; pointer-events: none; z-index: 2147483647;
            opacity: 0; transition: opacity 0.5s, bottom 0.2s;
            -webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%);
            mask-image: linear-gradient(to bottom, transparent 0%, black 30%, black 70%, transparent 100%);
        }
        .fm-out-lyrics-scroll.show { opacity: 1; }
        .fm-lrc-scroll-list { display: flex; flex-direction: column; align-items: center; transition: transform 0.45s cubic-bezier(0.25,0.8,0.25,1); }
        .fm-lrc-scroll-line {
            font-size: var(--fm-lrc-font, 16px); line-height: 1.8; color: var(--fm-text-sub); opacity: 0.35;
            text-align: center; text-shadow: 0 2px 8px var(--fm-shadow); white-space: nowrap; padding: 2px 10px;
            transition: opacity 0.4s, color 0.4s, font-size 0.4s;
        }
        .fm-lrc-scroll-line.near { opacity: 0.6; }
        .fm-lrc-scroll-line.current { color: var(--fm-accent); font-weight: bold; opacity: 1; font-size: calc(var(--fm-lrc-font, 16px) * 1.15); }

        .fm-lrc-settings-panel { display: none; flex-direction: column; gap: 10px; padding: 8px 0 4px; border-top: 0; }
        .fm-lrc-settings-panel.open { display: flex; }
        .fm-lrc-settings-row { display: flex; align-items: center; gap: 10px; }
        .fm-lrc-settings-label { font-size: 11px; color: var(--fm-text-sub); width: 56px; flex-shrink: 0; }
        .fm-lrc-mode-switch { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; flex: 1; }
        .fm-lrc-mode-btn { padding: 6px 0; font-size: 11px; text-align: center; border-radius: var(--fm-radius-input); border: 1px solid var(--fm-border); background: none; color: var(--fm-text-sub); cursor: pointer; transition: var(--fm-transition); }
        .fm-lrc-mode-btn.active { color: var(--fm-accent); border-color: var(--fm-accent); }
        .fm-lrc-settings-row input[type=range] { flex: 1; accent-color: var(--fm-accent); }
        .force-hide { display: none !important; }
        .ball-hidden .fm-ball { display: none !important; }

        .fm-page-play .fm-play-lyrics-settings { margin-top:2px; }
        .fm-page-play .fm-play-lyrics-settings .fm-lrc-settings-panel.open, .fm-page-more .fm-play-lyrics-settings .fm-lrc-settings-panel.open { display:flex; padding:8px 0 4px; border-top:0; }
        .fm-page-play .fm-quick-card { min-height:52px; box-sizing:border-box; }
        .fm-bottom-nav { grid-template-columns:repeat(2,1fr); }

        .fm-app-head { display:flex; align-items:center; justify-content:space-between; padding:14px 16px 10px; flex:0 0 auto; }
        .fm-brand { display:flex; align-items:center; min-width:0; }
        .fm-app-name { font-size:15px; font-weight:700; color:var(--fm-text-main); }
        .fm-app-sub { margin-top:2px; font-size:9px; letter-spacing:.16em; color:var(--fm-text-sub); }
        .fm-pages { flex:1 1 auto; min-height:0; overflow:hidden; position:relative; }
        .fm-page { display:none; height:100%; min-height:0; overflow-y:auto; overflow-x:hidden; padding:8px 16px 18px; box-sizing:border-box; scrollbar-width:thin; }
        .fm-page::-webkit-scrollbar { width: 4px; }
        .fm-page::-webkit-scrollbar-thumb { background: var(--fm-border); border-radius: 2px; }
        .fm-page.active { display:flex; flex-direction:column; gap:12px; }
        .fm-page.active > * { flex-shrink: 0; }
        .fm-section-kicker { font-size:9px; letter-spacing:.18em; color:var(--fm-accent); font-weight:800; margin-bottom:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .fm-page-title { display:flex; align-items:center; justify-content:space-between; padding:4px 2px 2px; }
        .fm-page-title h2 { margin:0; font-size:24px; line-height:1.1; color:var(--fm-text-main); }
        .fm-now-playing { display:flex; align-items:center; gap:14px; padding:14px; border:1px solid var(--fm-border); border-radius:18px; background:rgba(255,255,255,.06); }
        .fm-now-cover { width:82px; height:82px; flex:0 0 82px; border-radius:16px; display:flex; align-items:center; justify-content:center; background:var(--fm-border); color:var(--fm-text-sub); font-size:34px; overflow:hidden; }
        .fm-now-cover img { width:100%; height:100%; display:block; object-fit:cover; object-position:center; }
        .fm-decoration-preview { margin:4px 0 8px; display:flex; align-items:center; gap:10px; }
        .fm-decoration-preview .fm-now-cover { width:54px; height:54px; flex-basis:54px; font-size:23px; }
        .fm-decoration-preview-text { min-width:0; font-size:10px; line-height:1.45; color:var(--fm-text-sub); }
        .fm-decoration-preview-text strong { display:block; color:var(--fm-text-main); font-size:11px; margin-bottom:2px; }
        .fm-decoration-input { flex:1; min-width:0; height:34px; box-sizing:border-box; }
        .fm-now-meta { min-width:0; }
        .fm-now-meta .fm-title { font-size:18px; margin-bottom:5px; }
        .fm-now-meta .fm-artist { font-size:12px; }
        .fm-quick-card, .fm-status-card, .fm-setting-card, .fm-info-card, .fm-settings-section { border:0; border-radius:0; background:transparent; }
        .fm-quick-card { display:flex; align-items:center; justify-content:space-between; padding:8px 0; }
        .fm-quick-title, .fm-card-title, .fm-status-title { font-size:13px; font-weight:700; color:var(--fm-text-main); }
        .fm-quick-sub, .fm-card-sub, .fm-status-sub { margin-top:3px; font-size:10px; line-height:1.45; color:var(--fm-text-sub); }
        .fm-card-arrow, .fm-outline-btn { border:0; background:transparent; color:var(--fm-text-main); border-radius:10px; cursor:pointer; }
        .fm-card-arrow { width:32px; height:32px; }
        .fm-setting-card { overflow:visible; }
        .fm-setting-card-head { display:flex; align-items:center; justify-content:space-between; padding:8px 0 4px; }
        .fm-inline-icon-btn { width:30px; height:30px; }
        .fm-count-badge { padding:3px 0; font-size:9px; color:var(--fm-text-sub); }
        .fm-library-input { padding:0; border:0; gap:6px; }
        .fm-library-input .fm-select { min-width:72px; }
        .fm-library-input .fm-input { min-width:0; height:38px; box-sizing:border-box; }
        .fm-library-input .fm-add-btn { height:38px; }
        .fm-page-playlist { flex:0 0 auto; min-height:0; display:flex; flex-direction:column; gap:10px; }
        .fm-page-playlist .fm-list-section { min-height:150px; flex:0 0 auto; border:0; border-radius:0; overflow:visible; background:transparent; }
        .fm-page-playlist .fm-playlist-tabs { flex:0 0 auto; }
        .fm-page-playlist .fm-playlist { min-height:0; overflow:visible; }
        .fm-settings-section { padding:8px 0; }
        .fm-settings-section-title { font-size:12px; font-weight:800; color:var(--fm-text-main); margin-bottom:12px; }
        .fm-theme-row { display:flex; gap:10px; margin-bottom:14px; }
        .fm-theme-row .fm-theme-dot { width:28px; height:28px; }
        .fm-more-row { display:flex; align-items:center; gap:12px; min-height:38px; border-top:0; font-size:11px; color:var(--fm-text-sub); }
        .fm-more-row + .fm-more-row { margin-top:4px; }
        .fm-more-row > span { width:72px; flex:0 0 72px; }
        .fm-more-row input[type=range] { flex:1; min-width:0; accent-color:var(--fm-accent); }
        .fm-appearance-pair { display:grid; grid-template-columns:1fr 1fr; gap:14px; align-items:center; }
        .fm-appearance-pair .fm-more-row { min-width:0; }
        .fm-appearance-pair .fm-more-row > span { width:auto; flex:1; }
        .fm-color-picker { width:38px; height:26px; padding:0; border:0; background:transparent; }
        .fm-wide-btn { width:100%; height:36px; margin-top:8px; border:0; border-radius:10px; background:rgba(0,0,0,.05); color:var(--fm-text-main); display:flex; align-items:center; justify-content:center; gap:8px; cursor:pointer; font-size:11px; }
        .fm-bg-action-row { display:flex; gap:7px; margin-bottom:4px; }
        .fm-bg-btn { flex:1; height:34px; border:0; border-radius:10px; background:rgba(0,0,0,.05); color:var(--fm-text-main); cursor:pointer; font-size:10px; }
        .fm-range-with-icon { display:flex; align-items:center; gap:8px; flex:1; }
        .fm-range-with-icon i { width:12px; color:var(--fm-text-sub); font-size:10px; }
        .fm-switch { position:relative; width:42px; height:24px; flex:0 0 auto; display:inline-block; }
        .fm-switch input { opacity:0; width:0; height:0; position:absolute; }
        .fm-switch-slider { position:absolute; inset:0; cursor:pointer; border-radius:999px; background:rgba(0,0,0,.12); transition:.2s ease; }
        .fm-switch-slider::before { content:""; position:absolute; width:18px; height:18px; left:3px; top:3px; border-radius:50%; background:#fff; box-shadow:0 1px 4px rgba(0,0,0,.18); transition:.2s ease; }
        .fm-switch input:checked + .fm-switch-slider { background:var(--fm-accent); }
        .fm-switch input:checked + .fm-switch-slider::before { transform:translateX(18px); }

        .fm-bottom-nav { display:grid; grid-template-columns:repeat(2,1fr); gap:4px; padding:8px 8px max(8px, env(safe-area-inset-bottom)); border-top:0; background:rgba(0,0,0,.02); flex:0 0 auto; }
        .fm-nav-btn { min-width:0; height:44px; border:0; border-radius:13px; background:transparent; color:var(--fm-text-sub); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; cursor:pointer; font-size:10px; }
        .fm-nav-btn i { font-size:15px; }
        .fm-nav-btn.active { color:var(--fm-accent); background:transparent; }

        @media (min-width: 700px) {
            .fm-panel { width:400px; }
            .fm-page { padding-left:18px; padding-right:18px; }
        }
    `;
    shadow.appendChild(style);

    const wrapper = targetDoc.createElement('div');
    wrapper.className = `theme-${STATE.currentTheme}`;
    
    wrapper.innerHTML = `
        <div class="fm-ball" id="fm-ball" title="拖拽移动，点击展开"><i class="fas fa-music"></i></div>

        <div class="fm-panel" id="fm-panel">
            <div class="fm-panel-bg" id="fm-panel-bg"></div>

            <div class="fm-app-head">
                <div class="fm-brand">
                    <div class="fm-brand-text">
                        <div class="fm-app-name">АрⅤ Terminal</div>
                        <div class="fm-app-sub">MUSIC PLAYER</div>
                    </div>
                </div>
                <button class="fm-close-btn" id="fm-close"><i class="fas fa-times"></i></button>
            </div>

            <main class="fm-pages">
                <!-- 播放与歌单 -->
                <section class="fm-page fm-page-play active" data-page="play">
                    <div class="fm-now-playing">
                        <div class="fm-now-cover" id="fm-now-cover">
                            <i class="fas fa-compact-disc"></i>
                        </div>
                        <div class="fm-now-meta">
                            <div class="fm-section-kicker" id="fm-now-playing-label">NOW PLAYING</div>
                            <div class="fm-title" id="fm-title">АрⅤ Terminal</div>
                            <div class="fm-artist" id="fm-artist">Awaiting Connection...</div>
                        </div>
                    </div>

                    <div class="fm-progress-wrap" id="fm-progress-wrap">
                        <div class="fm-progress-track" id="fm-progress-track">
                            <div class="fm-progress-fill" id="fm-progress-fill"></div>
                            <div class="fm-progress-thumb" id="fm-progress-thumb"></div>
                        </div>
                        <div class="fm-time-row">
                            <span id="fm-time-current">0:00</span>
                            <span id="fm-time-duration">0:00</span>
                        </div>
                    </div>

                    <div class="fm-controls">
                        <button class="fm-btn" id="fm-mode" title="播放模式"><i class="fas fa-retweet"></i></button>
                        <button class="fm-btn" id="fm-prev"><i class="fas fa-step-backward"></i></button>
                        <button class="fm-btn play-pause" id="fm-play"><i class="fas fa-play"></i></button>
                        <button class="fm-btn" id="fm-next"><i class="fas fa-step-forward"></i></button>
                        <button class="fm-btn active-state" id="fm-lrc-toggle" title="外显歌词"><i class="fas fa-closed-captioning"></i></button>
                    </div>

                    <section class="fm-page-playlist" id="fm-playlist-section">
                        <div class="fm-page-title">
                            <div>
                                <div class="fm-section-kicker">LIBRARY</div>
                                <h2>歌单</h2>
                            </div>
                            <span class="fm-count-badge" id="fm-library-count">LIBRARY</span>
                        </div>

                        <div class="fm-input-wrap fm-library-input">
                            <select class="fm-select" id="fm-source-select">
                                <option value="netease">网易云</option>
                                <option value="tencent">QQ音乐</option>
                                <option value="search">搜单曲</option>
                                <option value="search_local">搜列表</option>
                            </select>
                            <input type="text" class="fm-input" id="fm-input" placeholder="输入歌单ID或链接" autocomplete="off">
                            <button class="fm-add-btn" id="fm-add">导入</button>
                        </div>

                        <div class="fm-list-section">
                            <div class="fm-playlist-tabs" id="fm-playlist-tabs"></div>
                            <div class="fm-playlist" id="fm-playlist"></div>
                        </div>
                    </section>
                </section>

                <!-- 外观设置 -->
                <section class="fm-page fm-page-more" data-page="more">
                    <div class="fm-page-title">
                        <div>
                            <div class="fm-section-kicker">CUSTOMIZE</div>
                            <h2>外观设置</h2>
                        </div>
                    </div>

                    <div class="fm-settings-section">
                        <div class="fm-settings-section-title">外观</div>
                        <div class="fm-theme-row">
                            <div class="fm-theme-dot dot-adaptive active" data-theme="adaptive" title="自适应"></div>
                            <div class="fm-theme-dot dot-light" data-theme="light" title="极简白"></div>
                            <div class="fm-theme-dot dot-dark" data-theme="dark" title="深邃黑"></div>
                            <div class="fm-theme-dot dot-glass" data-theme="glass" title="毛玻璃"></div>
                        </div>
                        <div class="fm-more-row">
                            <span>悬浮球大小</span>
                            <input type="range" class="fm-size-slider" id="fm-size-slider" min="30" max="80" value="50">
                        </div>
                        <div class="fm-appearance-pair">
                            <div class="fm-more-row">
                                <span>强调色</span>
                                <input type="color" class="fm-color-picker" id="fm-color-picker" value="#4a90e2">
                            </div>
                            <div class="fm-more-row">
                                <span>形状</span>
                                <button class="fm-wide-btn" id="fm-shape-btn"><i class="fas fa-square"></i><span>切换</span></button>
                            </div>
                        </div>
                        <div class="fm-more-row">
                            <span>悬浮球</span>
                            <label class="fm-switch" title="显示或隐藏悬浮球">
                                <input type="checkbox" id="fm-ball-visible-toggle">
                                <span class="fm-switch-slider"></span>
                            </label>
                        </div>
                    </div>

                    <div class="fm-settings-section fm-lyrics-settings-section">
                        <div class="fm-settings-section-title">歌词</div>
                        <div class="fm-setting-card fm-play-lyrics-settings">
                            <div class="fm-setting-card-head">
                                <div>
                                    <div class="fm-card-title">歌词显示</div>
                                    <div class="fm-card-sub">选择外显歌词样式、字号与位置</div>
                                </div>
                                <button class="fm-btn fm-inline-icon-btn" id="fm-lrc-settings" title="歌词设置"><i class="fas fa-sliders-h"></i></button>
                            </div>
                            <div class="fm-lrc-settings-panel open" id="fm-lrc-settings-panel">
                                <div class="fm-lrc-settings-row">
                                    <span class="fm-lrc-settings-label">样式</span>
                                    <div class="fm-lrc-mode-switch">
                                        <button class="fm-lrc-mode-btn" id="fm-lrc-mode-plain" data-mode="plain">普通歌词</button>
                                        <button class="fm-lrc-mode-btn" id="fm-lrc-mode-popup" data-mode="popup">逐句显现</button>
                                        <button class="fm-lrc-mode-btn" id="fm-lrc-mode-scroll" data-mode="scroll">三行滚动</button>
                                        <button class="fm-lrc-mode-btn" id="fm-lrc-mode-fall" data-mode="fall">随机掉落</button>
                                    </div>
                                </div>
                                <div class="fm-lrc-settings-row">
                                    <span class="fm-lrc-settings-label">字号</span>
                                    <input type="range" id="fm-lrc-font-slider" min="12" max="32" step="1">
                                </div>
                                <div class="fm-lrc-settings-row">
                                    <span class="fm-lrc-settings-label">位置</span>
                                    <input type="range" id="fm-lrc-bottom-slider" min="40" max="400" step="5">
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="fm-settings-section">
                        <div class="fm-settings-section-title">播放器小图装修</div>
                        <input type="file" id="fm-decoration-upload" accept="image/*" style="display:none;">
                        <div class="fm-decoration-preview">
                            <div class="fm-now-cover" id="fm-decoration-preview-cover"><i class="fas fa-compact-disc"></i></div>
                            <div class="fm-decoration-preview-text">
                                <strong>小图装饰</strong>
                                <span>上传一张小图片，替换播放卡片左侧的唱片图标。</span>
                            </div>
                        </div>
                        <div class="fm-bg-action-row">
                            <button class="fm-bg-btn" id="fm-decoration-btn-upload"><i class="fas fa-image"></i> 上传小图</button>
                            <button class="fm-bg-btn" id="fm-decoration-btn-clear"><i class="fas fa-trash"></i> 清除</button>
                        </div>
                        <div class="fm-more-row">
                            <span>播放标签</span>
                            <input type="text" class="fm-input fm-decoration-input" id="fm-decoration-label" maxlength="24" placeholder="NOW PLAYING" autocomplete="off">
                        </div>
                    </div>

                    <div class="fm-settings-section">
                        <div class="fm-settings-section-title">壁纸</div>
                        <input type="file" id="fm-bg-upload" accept="image/*" style="display:none;">
                        <div class="fm-bg-action-row">
                            <button class="fm-bg-btn" id="fm-bg-btn-upload"><i class="fas fa-image"></i> 上传壁纸</button>
                            <button class="fm-bg-btn" id="fm-bg-btn-clear"><i class="fas fa-trash"></i> 清除</button>
                            <button class="fm-bg-btn" id="fm-bg-btn-ratio"><i class="fas fa-crop-alt"></i> 比例</button>
                        </div>
                        <div class="fm-more-row">
                            <span>模糊</span>
                            <div class="fm-range-with-icon"><i class="fas fa-tint"></i><input type="range" class="fm-bg-slider" id="fm-bg-blur" min="0" max="30" value="10"></div>
                        </div>
                        <div class="fm-more-row">
                            <span>亮度</span>
                            <div class="fm-range-with-icon"><i class="fas fa-sun"></i><input type="range" class="fm-bg-slider" id="fm-bg-brightness" min="10" max="150" value="70"></div>
                        </div>
                    </div>
                </section>
            </main>

            <nav class="fm-bottom-nav" id="fm-bottom-nav">
                <button class="fm-nav-btn active" data-page-target="play">
                    <i class="fas fa-music"></i><span>播放与歌单</span>
                </button>
                <button class="fm-nav-btn" data-page-target="more">
                    <i class="fas fa-sliders-h"></i><span>外观设置</span>
                </button>
            </nav>
        </div>

        <div class="fm-pop-menu" id="fm-pop-menu"></div>
        <div class="fm-out-lyrics show" id="fm-out-lyrics"></div>
        <div class="fm-out-lyrics-scroll show" id="fm-out-lyrics-scroll"><div class="fm-lrc-scroll-list" id="fm-lrc-scroll-list"></div></div>
    `;
    shadow.appendChild(wrapper);

    const UI = {
        wrapper: wrapper,
        ball: wrapper.querySelector('#fm-ball'),
        panel: wrapper.querySelector('#fm-panel'),
        closeBtn: wrapper.querySelector('#fm-close'),
        title: wrapper.querySelector('#fm-title'),
        artist: wrapper.querySelector('#fm-artist'),
        nowCover: wrapper.querySelector('#fm-now-cover'),
        nowPlayingLabel: wrapper.querySelector('#fm-now-playing-label'),
        decorationPreviewCover: wrapper.querySelector('#fm-decoration-preview-cover'),
        decorationUploadInput: wrapper.querySelector('#fm-decoration-upload'),
        decorationUploadBtn: wrapper.querySelector('#fm-decoration-btn-upload'),
        decorationClearBtn: wrapper.querySelector('#fm-decoration-btn-clear'),
        decorationLabelInput: wrapper.querySelector('#fm-decoration-label'),
        playBtn: wrapper.querySelector('#fm-play'),
        prevBtn: wrapper.querySelector('#fm-prev'),
        nextBtn: wrapper.querySelector('#fm-next'),
        modeBtn: wrapper.querySelector('#fm-mode'),
        lrcToggleBtn: wrapper.querySelector('#fm-lrc-toggle'),
        lrcSettingsBtn: wrapper.querySelector('#fm-lrc-settings'),
        lrcSettingsPanel: wrapper.querySelector('#fm-lrc-settings-panel'),
        lrcModePlainBtn: wrapper.querySelector('#fm-lrc-mode-plain'),
        lrcModePopupBtn: wrapper.querySelector('#fm-lrc-mode-popup'),
        lrcModeScrollBtn: wrapper.querySelector('#fm-lrc-mode-scroll'),
        lrcModeFallBtn: wrapper.querySelector('#fm-lrc-mode-fall'),
        lrcFontSlider: wrapper.querySelector('#fm-lrc-font-slider'),
        lrcBottomSlider: wrapper.querySelector('#fm-lrc-bottom-slider'),
        outLyricsScroll: wrapper.querySelector('#fm-out-lyrics-scroll'),
        outLyricsScrollList: wrapper.querySelector('#fm-lrc-scroll-list'),
        sourceSelect: wrapper.querySelector('#fm-source-select'),
        input: wrapper.querySelector('#fm-input'),
        addBtn: wrapper.querySelector('#fm-add'),
        playlistTabs: wrapper.querySelector('#fm-playlist-tabs'),
        popMenu: wrapper.querySelector('#fm-pop-menu'),
        playlistEl: wrapper.querySelector('#fm-playlist'),
        themeDots: wrapper.querySelectorAll('.fm-theme-dot'),
        sizeSlider: wrapper.querySelector('#fm-size-slider'),
        colorPicker: wrapper.querySelector('#fm-color-picker'),
        shapeBtn: wrapper.querySelector('#fm-shape-btn'),
        ballVisibleToggle: wrapper.querySelector('#fm-ball-visible-toggle'),
        bgUploadInput: wrapper.querySelector('#fm-bg-upload'),
        bgUploadBtn: wrapper.querySelector('#fm-bg-btn-upload'),
        bgClearBtn: wrapper.querySelector('#fm-bg-btn-clear'),
        ratioBtn: wrapper.querySelector('#fm-bg-btn-ratio'),
        bgBlurSlider: wrapper.querySelector('#fm-bg-blur'),
        bgBrightnessSlider: wrapper.querySelector('#fm-bg-brightness'),
        outLyrics: wrapper.querySelector('#fm-out-lyrics'),
        progressTrack: wrapper.querySelector('#fm-progress-track'),
        progressFill: wrapper.querySelector('#fm-progress-fill'),
        progressThumb: wrapper.querySelector('#fm-progress-thumb'),
        timeCurrent: wrapper.querySelector('#fm-time-current'),
        timeDuration: wrapper.querySelector('#fm-time-duration')
    };

    // ================= 页面导航 =================
    UI.themeDots.forEach(dot => dot.classList.toggle('active', dot.dataset.theme === STATE.currentTheme));

    const pageEls = wrapper.querySelectorAll('.fm-page');
    const navEls = wrapper.querySelectorAll('.fm-nav-btn');

    function switchPlayerPage(pageName) {
        pageEls.forEach(page => page.classList.toggle('active', page.dataset.page === pageName));
        navEls.forEach(btn => btn.classList.toggle('active', btn.dataset.pageTarget === pageName));
    }

    navEls.forEach(btn => btn.addEventListener('click', () => switchPlayerPage(btn.dataset.pageTarget)));
    const quickLibraryBtn = wrapper.querySelector('#fm-quick-library-btn');
    if (quickLibraryBtn) quickLibraryBtn.addEventListener('click', () => {
        switchPlayerPage('play');
        const playlistSection = wrapper.querySelector('#fm-playlist-section');
        if (playlistSection) playlistSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    // ================= 核心逻辑 =================

    // 拖拽与面板定位
    function initDraggable() {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;
        let currentX, currentY;
        let rafId = null;
        let panelOffsetX = 0, panelOffsetY = 0;
        
        const initX = targetWin.innerWidth - 120;
        const initY = CONFIG.SAFE_MARGIN + 60;
        UI.ball.style.left = `${initX}px`;
        UI.ball.style.top = `${initY}px`;

        const updatePos = () => {
            if (!isDragging) return;
            const dx = currentX - startX;
            const dy = currentY - startY;
            
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) UI.ball.setAttribute('data-dragged', 'true');

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;
            
            const currentSize = parseInt(savedSettings.ballSize) || 50;
            const maxLeft = targetWin.innerWidth - currentSize - CONFIG.SAFE_MARGIN;
            const maxTop = targetWin.innerHeight - currentSize - CONFIG.SAFE_MARGIN;
            
            newLeft = Math.max(CONFIG.SAFE_MARGIN, Math.min(newLeft, maxLeft));
            newTop = Math.max(CONFIG.SAFE_MARGIN, Math.min(newTop, maxTop));

            UI.ball.style.left = `${newLeft}px`;
            UI.ball.style.top = `${newTop}px`;
            
            if (STATE.isExpanded) {
                const panelWidth = UI.panel.offsetWidth;
                const panelHeight = UI.panel.offsetHeight || 540;
                let pLeft = newLeft - panelOffsetX;
                let pTop = newTop - panelOffsetY;
                
                pLeft = Math.max(CONFIG.SAFE_MARGIN, Math.min(pLeft, targetWin.innerWidth - panelWidth - CONFIG.SAFE_MARGIN));
                pTop = Math.max(CONFIG.SAFE_MARGIN, Math.min(pTop, targetWin.innerHeight - panelHeight - CONFIG.SAFE_MARGIN));
                
                UI.panel.style.left = `${pLeft}px`;
                UI.panel.style.top = `${pTop}px`;
            }
            rafId = null;
        };

        const onDown = (e) => {
            if (e.button !== 0) return;
            isDragging = true;
            UI.ball.setAttribute('data-dragged', 'false');
            UI.ball.style.transition = 'none';

            const rect = UI.ball.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            startX = e.clientX; startY = e.clientY;
            currentX = startX; currentY = startY;
            
            if (STATE.isExpanded) {
                const pRect = UI.panel.getBoundingClientRect();
                panelOffsetX = initialLeft - pRect.left;
                panelOffsetY = initialTop - pRect.top;
                UI.panel.style.transition = 'none';
            }

            targetDoc.addEventListener('pointermove', onMove);
            targetDoc.addEventListener('pointerup', onUp);
            targetDoc.addEventListener('pointercancel', onUp);
            UI.ball.setPointerCapture(e.pointerId);
        };

        const onMove = (e) => {
            if (!isDragging) return;
            currentX = e.clientX; currentY = e.clientY;
            if (!rafId) rafId = requestAnimationFrame(updatePos);
        };

        const onUp = (e) => {
            if (!isDragging) return;
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; updatePos(); }
            isDragging = false;
            targetDoc.removeEventListener('pointermove', onMove);
            targetDoc.removeEventListener('pointerup', onUp);
            targetDoc.removeEventListener('pointercancel', onUp);
            try { UI.ball.releasePointerCapture(e.pointerId); } catch (err) {}
            requestAnimationFrame(() => { 
                UI.ball.style.transition = ''; 
                if (STATE.isExpanded) UI.panel.style.transition = '';
            });

            if (UI.ball.getAttribute('data-dragged') === 'false') togglePanel();
        };

        UI.ball.addEventListener('pointerdown', onDown);
    }

    // 修复：壁纸自适应与边界限制
    function togglePanel() {
        STATE.isExpanded = !STATE.isExpanded;
        const currentSize = parseInt(savedSettings.ballSize) || 50;
        
        if (STATE.isExpanded) {
            applySettings(); 
            
            // 使用实际 CSS 宽度，避免小屏 max-width 与 JS 估算不一致。
            const panelWidth = Math.min(UI.panel.offsetWidth || 400, targetWin.innerWidth - CONFIG.SAFE_MARGIN * 2);
            
            let estimatedHeight = 540;
            if (savedSettings.panelRatio === '3:4') {
                estimatedHeight = panelWidth * (4/3);
            } else if (savedSettings.panelRatio === '9:16') {
                estimatedHeight = panelWidth * (16/9);
            } else if (savedSettings.panelRatio === 'default' && savedSettings.bgImageWidth && savedSettings.bgImageHeight) {
                // 严格根据图片原始比例计算
                estimatedHeight = panelWidth * (savedSettings.bgImageHeight / savedSettings.bgImageWidth);
            }
            
            // 强力边界约束：无论计算出多高，绝对不能超出屏幕
            const maxAllowedHeight = targetWin.innerHeight - (CONFIG.SAFE_MARGIN * 2);
            const panelHeight = Math.min(estimatedHeight, maxAllowedHeight);
            
            // 应用计算后的高度
            UI.panel.style.height = `${panelHeight}px`;
            
            let pLeft = targetWin.innerWidth / 2 - panelWidth / 2;
            let pTop = targetWin.innerHeight / 2 - panelHeight / 2;
            
            pLeft = Math.max(CONFIG.SAFE_MARGIN, Math.min(pLeft, targetWin.innerWidth - panelWidth - CONFIG.SAFE_MARGIN));
            pTop = Math.max(CONFIG.SAFE_MARGIN, Math.min(pTop, targetWin.innerHeight - panelHeight - CONFIG.SAFE_MARGIN));
            
            UI.panel.style.left = `${pLeft}px`;
            UI.panel.style.top = `${pTop}px`;
            
            let bLeft, bTop;
            if (targetWin.innerHeight - (pTop + panelHeight) < 100) {
                bLeft = pLeft + panelWidth - currentSize / 2;
                bTop = pTop + panelHeight - currentSize / 2;
            } else {
                bLeft = pLeft - currentSize / 2;
                bTop = pTop - currentSize / 2;
            }
            
            bLeft = Math.max(CONFIG.SAFE_MARGIN, Math.min(bLeft, targetWin.innerWidth - currentSize - CONFIG.SAFE_MARGIN));
            bTop = Math.max(CONFIG.SAFE_MARGIN, Math.min(bTop, targetWin.innerHeight - currentSize - CONFIG.SAFE_MARGIN));
            
            UI.ball.style.left = `${bLeft}px`;
            UI.ball.style.top = `${bTop}px`;
            
            UI.ball.innerHTML = '<i class="fas fa-times"></i>';
            UI.ball.classList.remove('playing');
            UI.panel.classList.add('open');
        } else {
            UI.panel.classList.remove('open');
            UI.ball.innerHTML = '<i class="fas fa-music"></i>';
            if (STATE.isPlaying) UI.ball.classList.add('playing');
        }
    }

    // 进度条逻辑
    function withCacheBust(url) {
        if (!url) return url;
        try {
            const u = new URL(url, targetWin.location.href);
            u.searchParams.set('_t', Date.now());
            return u.toString();
        } catch (e) {
            return url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
        }
    }
    function formatTime(sec) {
        if (!isFinite(sec) || isNaN(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    function updateProgressUI(current, duration) {
        const pct = (duration && isFinite(duration) && duration > 0) ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;
        UI.progressFill.style.width = `${pct}%`;
        UI.progressThumb.style.left = `${pct}%`;
        UI.timeCurrent.textContent = formatTime(current);
        UI.timeDuration.textContent = formatTime(duration);
    }

    function initProgressBar() {
        const track = UI.progressTrack;
        const ratioFromEvent = (e) => {
            const rect = track.getBoundingClientRect();
            const x = e.clientX - rect.left;
            return Math.min(1, Math.max(0, x / rect.width));
        };
        const applyRatio = (ratio) => {
            const duration = audio.duration;
            UI.progressFill.style.width = `${ratio * 100}%`;
            UI.progressThumb.style.left = `${ratio * 100}%`;
            if (duration && isFinite(duration)) UI.timeCurrent.textContent = formatTime(ratio * duration);
            return duration;
        };

        const onDown = (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (!audio.duration || !isFinite(audio.duration)) return;
            STATE.isSeekingProgress = true;
            track.classList.add('dragging');
            applyRatio(ratioFromEvent(e));
            track.setPointerCapture(e.pointerId);
            track.addEventListener('pointermove', onMove);
            track.addEventListener('pointerup', onUp);
            track.addEventListener('pointercancel', onUp);
        };
        const onMove = (e) => { if (STATE.isSeekingProgress) applyRatio(ratioFromEvent(e)); };
        const onUp = (e) => {
            if (!STATE.isSeekingProgress) return;
            const duration = applyRatio(ratioFromEvent(e));
            if (duration && isFinite(duration)) audio.currentTime = ratioFromEvent(e) * duration;
            STATE.isSeekingProgress = false;
            track.classList.remove('dragging');
            track.removeEventListener('pointermove', onMove);
            track.removeEventListener('pointerup', onUp);
            track.removeEventListener('pointercancel', onUp);
            try { track.releasePointerCapture(e.pointerId); } catch (err) {}
        };
        track.addEventListener('pointerdown', onDown);
    }

    // 列表渲染逻辑
    function renderTabs() {
        UI.playlistTabs.innerHTML = '';
        STATE.playlists.forEach(p => {
            const tab = targetDoc.createElement('div');
            tab.className = `fm-tab ${p.id === STATE.currentPlaylistId ? 'active' : ''}`;
            
            if (p.id === 'default') {
                tab.textContent = p.name;
            } else {
                tab.innerHTML = `<span>${escapeHTML(p.name)}</span><i class="fas fa-times fm-tab-del" title="删除歌单"></i>`;
            }
            
            tab.onclick = (e) => {
                if (e.target.classList.contains('fm-tab-del')) {
                    e.stopPropagation();
                    if (confirm(`确定要删除歌单 [${p.name}] 吗？`)) {
                        STATE.playlists = STATE.playlists.filter(list => list.id !== p.id);
                        if (STATE.currentPlaylistId === p.id) STATE.currentPlaylistId = 'default';
                        if (STATE.playingPlaylistId === p.id) {
                            audio.pause();
                            STATE.playingPlaylistId = 'default';
                            STATE.currentIndex = -1;
                        }
                        savePlaylist();
                        renderListUI();
                    }
                    return;
                }
                STATE.currentPlaylistId = p.id;
                STATE.isShowingSearch = false;
                renderListUI();
            };
            UI.playlistTabs.appendChild(tab);
        });

        const addTab = targetDoc.createElement('div');
        addTab.className = 'fm-tab-add';
        addTab.innerHTML = '<i class="fas fa-plus"></i>';
        addTab.title = "新建歌单";
        addTab.onclick = () => {
            const name = prompt("请输入新歌单名称：", "新建歌单");
            if (name && name.trim()) {
                const newId = 'pl_' + Date.now();
                STATE.playlists.push({ id: newId, name: name.trim(), tracks: [] });
                STATE.currentPlaylistId = newId;
                savePlaylist();
                renderListUI();
            }
        };
        UI.playlistTabs.appendChild(addTab);
    }

    // 事件发生在 Shadow DOM 内，监听 wrapper 比监听宿主 document 更可靠。
    wrapper.addEventListener('click', (e) => {
        if (!e.target.closest('#fm-pop-menu') && !e.target.closest('.fm-icon-btn')) {
            UI.popMenu.classList.remove('show');
        }
    });

    // 修复：下拉菜单越界适配
    function showAddMenu(e, track, actionType = 'add', sourceIndex = -1, sourcePlaylistId = null) {
        e.stopPropagation();
        
        const availablePlaylists = actionType === 'move' 
            ? STATE.playlists.filter(p => p.id !== sourcePlaylistId)
            : STATE.playlists;

        if (availablePlaylists.length === 0) {
            API.toast("没有其他歌单可供移动");
            return;
        }

        if (availablePlaylists.length === 1 && actionType === 'add') {
            addTrackToPlaylist(track, availablePlaylists[0].id);
            return;
        }

        UI.popMenu.innerHTML = '';
        availablePlaylists.forEach(p => {
            const item = targetDoc.createElement('div');
            item.className = 'fm-pop-item';
            item.textContent = `${actionType === 'move' ? '移动' : '添加'}至: ${p.name}`;
            item.onclick = () => {
                if (actionType === 'move') {
                    moveTrackToPlaylist(track, sourceIndex, sourcePlaylistId, p.id);
                } else {
                    addTrackToPlaylist(track, p.id);
                }
                UI.popMenu.classList.remove('show');
            };
            UI.popMenu.appendChild(item);
        });

        // 智能定位：使用 fixed 定位，完全相对于视口计算，摆脱面板边界束缚
        const anchor = e.target.closest?.('.fm-icon-btn, button') || e.currentTarget;
        const rect = anchor.getBoundingClientRect();
        
        // 预估菜单高度（每项约32px，最大200px）
        const estimatedMenuHeight = Math.min(availablePlaylists.length * 32 + 10, 200);
        
        let top;
        // 如果点击位置距离视口底部不足以放下菜单，则向上展开
        if (rect.bottom + estimatedMenuHeight > targetWin.innerHeight - 10) {
            top = rect.top - estimatedMenuHeight;
        } else {
            top = rect.bottom;
        }
        
        const menuWidth = 140;
        let left = rect.left - 100;
        left = Math.max(10, Math.min(left, targetWin.innerWidth - menuWidth - 10));
        top = Math.max(10, Math.min(top, targetWin.innerHeight - estimatedMenuHeight - 10));
        
        UI.popMenu.style.top = `${top}px`;
        UI.popMenu.style.left = `${left}px`;
        UI.popMenu.classList.add('show');
    }

    function addTrackToPlaylist(track, playlistId) {
        const targetList = STATE.playlists.find(p => p.id === playlistId);
        if (targetList) {
            if (targetList.tracks.length >= CONFIG.MAX_TRACKS_PER_LIST) {
                API.toast(`歌单 [${targetList.name}] 已达到上限 (${CONFIG.MAX_TRACKS_PER_LIST}首)，无法继续添加`);
                return;
            }
            const exists = targetList.tracks.some(t => trackDedupeKey(t) === trackDedupeKey(track));
            if (exists) {
                API.toast(`《${track.title}》已经在 [${targetList.name}] 里了，没有重复添加`);
                STATE.isShowingSearch = false;
                renderListUI();
                return;
            }
            targetList.tracks.push(track);
            savePlaylist();
            API.toast(`已添加至 [${targetList.name}]`);
            STATE.isShowingSearch = false;
            STATE.currentPlaylistId = playlistId;
            renderListUI();
            
            if (STATE.currentIndex === -1 && STATE.playingPlaylistId === playlistId) {
                playTrack(targetList.tracks.length - 1, playlistId);
            }
        }
    }

    function moveTrackToPlaylist(track, sourceIndex, sourcePlaylistId, targetPlaylistId) {
        const sourceList = STATE.playlists.find(p => p.id === sourcePlaylistId);
        const targetList = STATE.playlists.find(p => p.id === targetPlaylistId);
        
        if (sourceList && targetList && sourceIndex >= 0) {
            if (targetList.tracks.length >= CONFIG.MAX_TRACKS_PER_LIST) {
                API.toast(`目标歌单已达到上限 (${CONFIG.MAX_TRACKS_PER_LIST}首)，无法移动`);
                return;
            }
            sourceList.tracks.splice(sourceIndex, 1);
            
            if (STATE.playingPlaylistId === sourcePlaylistId) {
                if (sourceIndex === STATE.currentIndex) {
                    audio.pause();
                    if (sourceList.tracks.length > 0) playTrack(sourceIndex % sourceList.tracks.length, sourcePlaylistId);
                    else {
                        STATE.currentIndex = -1;
                        UI.title.textContent = 'АрⅤ Terminal';
                        UI.artist.textContent = 'Awaiting Connection...';
                        UI.outLyrics.innerHTML = '';
                    }
                } else if (sourceIndex < STATE.currentIndex) {
                    STATE.currentIndex--;
                }
            }

            targetList.tracks.push(track);
            savePlaylist();
            API.toast(`已移动至 [${targetList.name}]`);
            renderListUI();
        }
    }

    function renderListUI() {
        renderTabs();
        UI.playlistEl.innerHTML = '';
        
        if (STATE.isShowingSearch) {
            const header = targetDoc.createElement('div');
            header.className = 'fm-search-header';
            header.innerHTML = `<span>搜索结果 (${STATE.searchResults.length})</span><span class="fm-back-list">返回列表</span>`;
            header.querySelector('.fm-back-list').onclick = () => {
                STATE.isShowingSearch = false;
                renderListUI();
            };
            UI.playlistEl.appendChild(header);

            if (STATE.searchResults.length === 0) {
                UI.playlistEl.innerHTML += '<div style="padding:16px;text-align:center;color:var(--fm-text-sub);font-size:12px;">未找到相关歌曲</div>';
                return;
            }

            STATE.searchResults.forEach((track, index) => {
                const item = targetDoc.createElement('div');
                item.className = 'fm-item';
                item.innerHTML = `
                    <div class="fm-item-info">
                        <span class="fm-item-title">${escapeHTML(track.title)}</span>
                        <span class="fm-item-artist">${escapeHTML(track.artist)} · ${track.source === 'netease' ? '网易云' : '其他'}</span>
                    </div>
                    <div class="fm-item-actions">
                        <button class="fm-icon-btn" title="添加至歌单"><i class="fas fa-plus"></i></button>
                    </div>
                `;
                item.querySelector('.fm-icon-btn').onclick = (e) => showAddMenu(e, track, 'add');
                UI.playlistEl.appendChild(item);
            });
        } else {
            const currentListObj = getCurrentPlaylist();
            const currentTracks = currentListObj.tracks;

            if (currentTracks.length === 0) {
                UI.playlistEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--fm-text-sub);font-size:12px;">列表为空，请导入或搜索</div>';
                return;
            }

            let listToRender = currentTracks.map((track, index) => ({ track, index }));
            if (STATE.currentInputMode === 'search_local' && STATE.localSearchKeyword) {
                listToRender = listToRender.filter(item => 
                    item.track.title.toLowerCase().includes(STATE.localSearchKeyword) || 
                    item.track.artist.toLowerCase().includes(STATE.localSearchKeyword)
                );
            }

            const header = targetDoc.createElement('div');
            header.className = 'fm-search-header';
            
            if (STATE.currentInputMode === 'search_local' && STATE.localSearchKeyword) {
                header.innerHTML = `<span>搜索结果 (${listToRender.length})</span><span class="fm-clear-list">清除搜索</span>`;
                header.querySelector('.fm-clear-list').onclick = () => {
                    STATE.localSearchKeyword = '';
                    UI.input.value = '';
                    renderListUI();
                };
            } else {
                header.innerHTML = `<span>${currentListObj.name} (${currentTracks.length})</span><span class="fm-clear-list">清空列表</span>`;
                header.querySelector('.fm-clear-list').onclick = () => {
                    if (confirm(`确定清空 [${currentListObj.name}] 吗？`)) {
                        currentListObj.tracks = [];
                        savePlaylist();
                        if (STATE.playingPlaylistId === currentListObj.id) {
                            audio.pause();
                            STATE.currentIndex = -1;
                            UI.title.textContent = 'АрⅤ Terminal';
                            UI.artist.textContent = 'Awaiting Connection...';
                            UI.outLyrics.innerHTML = '';
                        }
                        renderListUI();
                        API.toast("列表已清空");
                    }
                };
            }
            UI.playlistEl.appendChild(header);

            if (listToRender.length === 0) {
                UI.playlistEl.innerHTML += '<div style="padding:16px;text-align:center;color:var(--fm-text-sub);font-size:12px;">未找到匹配的歌曲</div>';
                return;
            }

            listToRender.forEach(({ track, index }) => {
                const isActive = (STATE.playingPlaylistId === currentListObj.id && index === STATE.currentIndex);
                const item = targetDoc.createElement('div');
                item.className = `fm-item ${isActive ? 'active' : ''}`;
                item.innerHTML = `
                    <div class="fm-item-info">
                        <span class="fm-item-title">${escapeHTML(track.title)}</span>
                        <span class="fm-item-artist">${escapeHTML(track.artist)}</span>
                    </div>
                    <div class="fm-item-actions">
                        <button class="fm-icon-btn move" title="移动至其他歌单"><i class="fas fa-exchange-alt"></i></button>
                        <button class="fm-icon-btn pinned ${index === 0 ? 'pinned' : ''}" title="置顶"><i class="fas fa-thumbtack"></i></button>
                        <button class="fm-icon-btn del" title="移除"><i class="fas fa-trash-alt"></i></button>
                    </div>
                `;
                
                item.addEventListener('click', (e) => {
                    if (e.target.closest('.del')) {
                        e.stopPropagation(); removeTrack(index, currentListObj.id);
                    } else if (e.target.closest('.pinned')) {
                        e.stopPropagation(); pinTrack(index, currentListObj.id);
                    } else if (e.target.closest('.move')) {
                        e.stopPropagation(); showAddMenu(e, track, 'move', index, currentListObj.id);
                    } else {
                        playTrack(index, currentListObj.id);
                    }
                });
                UI.playlistEl.appendChild(item);
            });
        }
    }

    function pinTrack(index, playlistId) {
        const targetList = STATE.playlists.find(p => p.id === playlistId);
        if (!targetList || index <= 0 || index >= targetList.tracks.length) return;
        
        const [track] = targetList.tracks.splice(index, 1);
        targetList.tracks.unshift(track);
        
        if (STATE.playingPlaylistId === playlistId) {
            if (STATE.currentIndex === index) STATE.currentIndex = 0;
            else if (STATE.currentIndex >= 0 && STATE.currentIndex < index) STATE.currentIndex += 1;
        }
        savePlaylist();
        renderListUI();
    }

    function removeTrack(index, playlistId) {
        const targetList = STATE.playlists.find(p => p.id === playlistId);
        if (!targetList) return;

        targetList.tracks.splice(index, 1);
        
        if (STATE.playingPlaylistId === playlistId) {
            if (index === STATE.currentIndex) {
                audio.pause();
                if (targetList.tracks.length > 0) playTrack(index % targetList.tracks.length, playlistId);
                else {
                    STATE.currentIndex = -1;
                    UI.title.textContent = 'АрⅤ Terminal';
                    UI.artist.textContent = 'Awaiting Connection...';
                    UI.outLyrics.innerHTML = '';
                }
            } else if (index < STATE.currentIndex) {
                STATE.currentIndex--;
            }
        }
        savePlaylist();
        renderListUI();
    }

    // 播放核心逻辑
    async function playTrack(index, playlistId = STATE.playingPlaylistId, isRetry = false) {
        const targetList = STATE.playlists.find(p => p.id === playlistId);
        if (!targetList || index < 0 || index >= targetList.tracks.length) return;
        
        STATE.playingPlaylistId = playlistId;
        STATE.currentIndex = index;
        const requestId = ++STATE.playRequestId;
        const track = targetList.tracks[index];

        if (!isRetry) track.__retriedOnError = false;
        
        UI.title.textContent = track.title;
        UI.artist.textContent = track.artist;
        renderListUI();

        audio.pause(); audio.src = '';
        STATE.lyricsData = []; UI.outLyrics.innerHTML = ''; UI.outLyricsScrollList.innerHTML = ''; STATE.lastActiveLrcIndex = -1;
        if (lrcRafId) cancelAnimationFrame(lrcRafId);
        updateProgressUI(0, 0);

        if (!track.url) {
            UI.title.textContent = "解析音源中...";
            let searchRes = await API.fillTrackInfo(track.title, track.artist);
            if (!searchRes && track.rawId) searchRes = { id: track.rawId, source: track.source || 'netease' };
            
            if (searchRes) {
                track.source = searchRes.source || track.source;
                track.id = searchRes.id;
                track.lyricId = searchRes.lyric_id || searchRes.id;
                track.url = await API.getUrl(track.source, track.id);
            }
        }

        if (STATE.playRequestId !== requestId || STATE.playingPlaylistId !== playlistId || STATE.currentIndex !== index) return;

        if (track.url) {
            UI.title.textContent = track.title;
            audio.__playToken = requestId;
            audio.src = withCacheBust(track.url);
            audio.play().catch(e => console.warn("Auto-play prevented", e));
            
            if (track.lrcUrl || track.lyricId || track.rawId) {
                let lyricSource = track.source;
                let lyricId = track.lyricId || track.rawId;
                let lrcData = null;

                if (track.lrcUrl) {
                    lrcData = await API.getLyricByUrl(track.lrcUrl);
                    if (STATE.playRequestId !== requestId || STATE.playingPlaylistId !== playlistId || STATE.currentIndex !== index) return;
                }

                if (!lrcData || lrcData.__error || !lrcData.lyric) {
                    if (lyricId) {
                        lrcData = await API.getLyric(lyricSource, lyricId);
                        if (STATE.playRequestId !== requestId || STATE.playingPlaylistId !== playlistId || STATE.currentIndex !== index) return;
                    }
                }

                if (!lrcData || lrcData.__error || !lrcData.lyric) {
                    const searchRes = await API.fillTrackInfo(track.title, track.artist);
                    if (STATE.playRequestId !== requestId || STATE.playingPlaylistId !== playlistId || STATE.currentIndex !== index) return;
                    if (searchRes) {
                        lyricSource = searchRes.source || lyricSource;
                        lyricId = searchRes.lyric_id || searchRes.id;
                        lrcData = await API.getLyric(lyricSource, lyricId);
                        if (STATE.playRequestId !== requestId || STATE.playingPlaylistId !== playlistId || STATE.currentIndex !== index) return;
                    }
                }

                if (lrcData && !lrcData.__error && lrcData.lyric) {
                    if (lyricId) track.lyricId = lyricId;
                    parseLyric(lrcData.lyric, lrcData.tlyric);
                    buildScrollLyricsDom(); 
                    if (lrcRafId) cancelAnimationFrame(lrcRafId);
                    if (STATE.isLyricsVisible && !audio.paused) updateLyrics();
                }
            }
        } else {
            UI.title.textContent = "音源不可用，跳过";
            API.toast(`[${track.title}] 音源解析失败，已跳过`);
            setTimeout(() => playNext(), 2000);
        }
    }

    function playNext() {
        const playingList = getPlayingPlaylist().tracks;
        if (playingList.length === 0) return;
        let nextIdx = STATE.currentIndex;
        if (STATE.playMode === 'shuffle') nextIdx = Math.floor(Math.random() * playingList.length);
        else nextIdx = (STATE.currentIndex + 1) % playingList.length;
        playTrack(nextIdx, STATE.playingPlaylistId);
    }

    function playPrev() {
        const playingList = getPlayingPlaylist().tracks;
        if (playingList.length === 0) return;
        let prevIdx = STATE.currentIndex;
        if (STATE.playMode === 'shuffle') prevIdx = Math.floor(Math.random() * playingList.length);
        else prevIdx = (STATE.currentIndex - 1 + playingList.length) % playingList.length;
        playTrack(prevIdx, STATE.playingPlaylistId);
    }

    // 歌词解析
    function parseLyric(lrcStr, tlrcStr) {
        STATE.lyricsData = [];
        const timeExp = /\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?\]/g;
        const parse = (str) => {
            const map = new Map();
            if (!str) return map;
            const lines = str.split('\n');
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;

                const timestamps = [...line.matchAll(timeExp)];
                const txt = line.replace(timeExp, '').trim();
                if (!txt || timestamps.length === 0) continue;

                timestamps.forEach(result => {
                    const min = parseInt(result[1], 10);
                    const sec = parseInt(result[2], 10);
                    const ms = result[3] ? parseInt(result[3].padEnd(3, '0'), 10) : 0;
                    map.set((min * 60 + sec + ms / 1000).toFixed(3), txt);
                });
                timeExp.lastIndex = 0;
            }
            return map;
        };

        const lrcMap = parse(lrcStr);
        const tlrcMap = parse(tlrcStr);
        const times = Array.from(lrcMap.keys()).sort((a, b) => parseFloat(a) - parseFloat(b));
        times.forEach(t => {
            STATE.lyricsData.push({ time: parseFloat(t), text: lrcMap.get(t), trans: tlrcMap.get(t) || '' });
        });
    }

    function buildScrollLyricsDom() {
        UI.outLyricsScrollList.innerHTML = '';
        STATE.lyricsData.forEach((line) => {
            const div = targetDoc.createElement('div');
            div.className = 'fm-lrc-scroll-line';
            div.textContent = line.text;
            UI.outLyricsScrollList.appendChild(div);
        });
        UI.outLyricsScrollList.style.transform = 'translateY(0px)';
    }

    function renderScrollActiveLine(activeIdx) {
        const lineEls = UI.outLyricsScrollList.children;
        if (lineEls.length === 0) return;
        for (let i = 0; i < lineEls.length; i++) {
            lineEls[i].classList.remove('current', 'near');
            if (i === activeIdx) lineEls[i].classList.add('current');
            else if (Math.abs(i - activeIdx) === 1) lineEls[i].classList.add('near');
        }
        const activeLine = lineEls[activeIdx];
        if (!activeLine) return;
        const containerHeight = UI.outLyricsScroll.clientHeight;
        const targetCenter = activeLine.offsetTop + activeLine.offsetHeight / 2;
        const offset = containerHeight / 2 - targetCenter;
        UI.outLyricsScrollList.style.transform = `translateY(${offset}px)`;
    }

    // 修复：歌词动画优化，使用更平滑的延迟
    function updateLyrics() {
        if (!STATE.isLyricsVisible || STATE.lyricsData.length === 0 || audio.paused) return;
        const ct = audio.currentTime;
        const isFallMode = savedSettings.lrcMode === 'fall';
        
        // 随机掉落模式下，提前 0.8 秒触发下一句，实现交叠效果
        const effectiveTime = ct + (isFallMode ? 0.8 : 0);
        
        let activeIdx = -1;
        for (let i = STATE.lyricsData.length - 1; i >= 0; i--) {
            if (effectiveTime >= STATE.lyricsData[i].time) { activeIdx = i; break; }
        }

        if (activeIdx !== -1 && activeIdx !== STATE.lastActiveLrcIndex) {
            STATE.lastActiveLrcIndex = activeIdx;

            if (savedSettings.lrcMode === 'scroll') {
                renderScrollActiveLine(activeIdx);
            } else if (savedSettings.lrcMode === 'plain') {
                const line = STATE.lyricsData[activeIdx];
                UI.outLyrics.replaceChildren();

                const lineEl = targetDoc.createElement('div');
                lineEl.className = 'fm-lrc-plain-line';
                lineEl.textContent = line.text || '';
                UI.outLyrics.appendChild(lineEl);

                if (line.trans) {
                    const transEl = targetDoc.createElement('div');
                    transEl.className = 'fm-lrc-trans fm-lrc-plain-trans';
                    transEl.textContent = line.trans;
                    UI.outLyrics.appendChild(transEl);
                }
            } else {
                const line = STATE.lyricsData[activeIdx];
                
                let duration = 4.0;
                if (activeIdx < STATE.lyricsData.length - 1) {
                    duration = STATE.lyricsData[activeIdx + 1].time - line.time;
                }
                
                const chars = line.text.split('');
                const validCharsCount = line.text.replace(/\s/g, '').length || 1;
                const isFallMode = savedSettings.lrcMode === 'fall';
                
                let html = `<div class="fm-lrc-line">`;
                
                if (isFallMode) {
                    // 随机掉落模式逻辑
                    let validIndices = [];
                    chars.forEach((c, i) => { if (c !== ' ') validIndices.push(i); });
                    
                    for (let i = validIndices.length - 1; i > 0; i--) {
                        const j = Math.floor(Math.random() * (i + 1));
                        [validIndices[i], validIndices[j]] = [validIndices[j], validIndices[i]];
                    }
                    // 保留随机掉落的随机性，但强制这一句的最后一个非空白字符最后掉落。
                    if (validIndices.length > 1) {
                        const lastIndex = validIndices.length - 1;
                        const finalCharIndex = validIndices.findIndex(index => index === chars.length - 1);
                        if (finalCharIndex !== -1) {
                            [validIndices[finalCharIndex], validIndices[lastIndex]] = [validIndices[lastIndex], validIndices[finalCharIndex]];
                        }
                    }
                    
                    const delayOrderMap = new Map();
                    validIndices.forEach((originalIndex, randomOrder) => {
                        delayOrderMap.set(originalIndex, randomOrder);
                    });

                    // 严格限制时间：确保 (最大延迟 + 动画时长) < 句子总时长
                    // 基础动画时长为 0.8s，预留 10% 的缓冲时间
                    const animDuration = 0.8;
                    const safeDuration = duration * 0.9;
                    
                    let maxTotalDelay;
                    let speedScale = 1.0; // 用于在极短句子中加速动画本身

                    if (safeDuration > animDuration + 0.5) {
                        // 时间充裕，最大延迟限制在 1.5s 内
                        maxTotalDelay = Math.min(safeDuration - animDuration, 1.5);
                    } else {
                        // 时间紧迫，压缩动画和延迟
                        maxTotalDelay = safeDuration * 0.4;
                        speedScale = (safeDuration * 0.6) / animDuration;
                    }

                    const delayStep = maxTotalDelay / Math.max(1, validCharsCount - 1);

                    chars.forEach((c, i) => {
                        if (c === ' ') { html += ' '; return; }
                        
                        const randomOrder = delayOrderMap.get(i);
                        const delay = randomOrder * delayStep;
                        const highlightClass = ['你', '我', '爱'].includes(c) ? ' lrc-highlight' : '';
                        
                        // 如果时间紧迫，通过内联样式覆盖 animation-duration 加速动画
                        const animStyle = speedScale < 1.0 
                            ? `animation-duration: ${animDuration * speedScale}s; animation-delay: ${delay}s;`
                            : `animation-delay: ${delay}s;`;
                            
                        html += `<span class="lrc-anim-fall${highlightClass}" style="${animStyle}">${c}</span>`;
                    });
                } else {
                    // 原有的逐句弹出模式逻辑
                    const charDelay = Math.min(0.15, Math.max(0.04, (duration * 0.4) / validCharsCount));
                    let charIndex = 0;
                    chars.forEach((c) => {
                        if (c === ' ') { html += ' '; return; }
                        html += `<span class="lrc-anim-char" style="animation-delay:${charIndex * charDelay}s">${c}</span>`;
                        charIndex++;
                    });
                }
                
                html += `</div>`;
                
                if (line.trans) {
                    // 随机掉落模式下，翻译固定较短延迟，且使用专用的无位移渐现动画
                    const transDelay = isFallMode ? 0.3 : Math.min(duration * 0.3, validCharsCount * 0.1 + 0.2);
                    const animClass = isFallMode ? 'lrc-trans-fade' : 'lrc-anim-char';
                    html += `<div class="fm-lrc-trans ${animClass}" style="animation-delay:${transDelay}s">${line.trans}</div>`;
                }
                
                // 处理旧歌词的退场动画（原地雾化消散）
                if (isFallMode) {
                    const oldLines = Array.from(UI.outLyrics.children);
                    oldLines.forEach(el => {
                        if (!el.classList.contains('exiting')) {
                            el.classList.add('exiting');
                            // 锁定位置，脱离文档流，防止影响新歌词排版
                            el.style.position = 'absolute';
                            el.style.bottom = '0';
                            el.style.left = '50%';
                            el.style.transform = 'translateX(-50%)';
                            el.style.width = 'max-content';
                            el.style.pointerEvents = 'none';
                            
                            // 给整个旧行应用原地模糊消散动画，使其与新歌词的掉落自然交叠
                            el.style.animation = 'lrc-fade-out 0.8s ease-out forwards';
                            
                            // 移除内部字符可能残留的动画，防止冲突
                            const spans = el.querySelectorAll('span, div');
                            spans.forEach(span => {
                                span.style.animation = 'none';
                            });
                            
                            setTimeout(() => { if (el.parentNode) el.remove(); }, 800);
                        }
                    });
                    
                    // 将新歌词包裹在一个容器中追加，而不是直接覆写 innerHTML
                    const newWrapper = targetDoc.createElement('div');
                    newWrapper.className = 'fm-lrc-line-wrapper';
                    newWrapper.style.display = 'flex';
                    newWrapper.style.flexDirection = 'column';
                    newWrapper.style.alignItems = 'center';
                    newWrapper.style.gap = '4px';
                    newWrapper.innerHTML = html;
                    UI.outLyrics.appendChild(newWrapper);
                } else {
                    UI.outLyrics.innerHTML = html;
                }
            }
        }
        // 歌词只需要在播放进度更新时检查当前行，不再用 requestAnimationFrame 每帧扫描。
        // 这样可以避免歌词开启后占满主线程，尤其适合手机端。
        lrcRafId = null;
    }

    // ================= 事件绑定 =================
    
    UI.closeBtn.onclick = togglePanel;
    
    UI.playBtn.onclick = () => {
        const playingList = getPlayingPlaylist().tracks;
        if (playingList.length === 0) return;
        if (audio.paused) {
            if (STATE.currentIndex === -1) playTrack(0, STATE.playingPlaylistId);
            else audio.play();
        } else audio.pause();
    };

    UI.prevBtn.onclick = playPrev;
    UI.nextBtn.onclick = playNext;

    UI.modeBtn.onclick = () => {
        const modes = ['repeat_all', 'repeat_one', 'shuffle'];
        const icons = ['fa-retweet', 'fa-redo-alt', 'fa-random'];
        let idx = (modes.indexOf(STATE.playMode) + 1) % modes.length;
        STATE.playMode = modes[idx];
        UI.modeBtn.innerHTML = `<i class="fas ${icons[idx]}"></i>`;
    };

    function getActiveLyricsEl() {
        return savedSettings.lrcMode === 'scroll' ? UI.outLyricsScroll : UI.outLyrics;
    }
    function syncLyricsVisibility() {
        const active = getActiveLyricsEl();
        const inactive = (active === UI.outLyrics) ? UI.outLyricsScroll : UI.outLyrics;
        inactive.classList.remove('show');
        active.classList.toggle('show', STATE.isLyricsVisible);
    }

    UI.lrcToggleBtn.onclick = () => {
        STATE.isLyricsVisible = !STATE.isLyricsVisible;
        UI.lrcToggleBtn.classList.toggle('active-state', STATE.isLyricsVisible);
        syncLyricsVisibility();
        if (!STATE.isLyricsVisible) {
            UI.outLyrics.innerHTML = '';
            UI.outLyricsScrollList.innerHTML = '';
        } else if (!audio.paused) {
            STATE.lastActiveLrcIndex = -1;
            updateLyrics();
        }
    };

    UI.lrcSettingsBtn.onclick = () => {
        UI.lrcSettingsPanel.classList.toggle('open');
    };

    UI.lrcModePlainBtn.onclick = () => {
        if (savedSettings.lrcMode === 'plain') return;
        savedSettings.lrcMode = 'plain';
        updateLrcModeBtns();
        STATE.lastActiveLrcIndex = -1;
        if (lrcRafId) { cancelAnimationFrame(lrcRafId); lrcRafId = null; }
        syncLyricsVisibility();
        if (STATE.isLyricsVisible && !audio.paused) updateLyrics();
        applySettings();
    };

    UI.lrcModePopupBtn.onclick = () => {
        if (savedSettings.lrcMode === 'popup') return;
        savedSettings.lrcMode = 'popup';
        updateLrcModeBtns();
        STATE.lastActiveLrcIndex = -1;
        syncLyricsVisibility();
        if (STATE.isLyricsVisible && !audio.paused) updateLyrics();
        applySettings();
    };
    UI.lrcModeScrollBtn.onclick = () => {
        if (savedSettings.lrcMode === 'scroll') return;
        savedSettings.lrcMode = 'scroll';
        updateLrcModeBtns();
        STATE.lastActiveLrcIndex = -1;
        syncLyricsVisibility();
        if (STATE.lyricsData.length > 0) buildScrollLyricsDom();
        if (STATE.isLyricsVisible && !audio.paused) updateLyrics();
        applySettings();
    };
    UI.lrcModeFallBtn.onclick = () => {
        if (savedSettings.lrcMode === 'fall') return;
        savedSettings.lrcMode = 'fall';
        updateLrcModeBtns();
        STATE.lastActiveLrcIndex = -1;
        syncLyricsVisibility();
        if (STATE.isLyricsVisible && !audio.paused) updateLyrics();
        applySettings();
    };

    UI.lrcFontSlider.oninput = (e) => {
        savedSettings.lrcFont = e.target.value;
        applySettings(false);
        scheduleSettingsSave();
        if (savedSettings.lrcMode === 'scroll' && STATE.lastActiveLrcIndex !== -1) renderScrollActiveLine(STATE.lastActiveLrcIndex);
    };
    UI.lrcBottomSlider.oninput = (e) => {
        savedSettings.lrcBottom = e.target.value;
        applySettings(false);
        scheduleSettingsSave();
    };

    UI.sourceSelect.onchange = (e) => {
        STATE.currentInputMode = e.target.value;
        if (STATE.currentInputMode === 'search') {
            UI.input.placeholder = "输入歌曲名或歌手名";
            UI.addBtn.textContent = "搜索";
        } else if (STATE.currentInputMode === 'search_local') {
            UI.input.placeholder = "在播放列表中查找";
            UI.addBtn.textContent = "查找";
        } else {
            UI.input.placeholder = "输入歌单ID或链接";
            UI.addBtn.textContent = "导入";
        }
        STATE.localSearchKeyword = '';
        renderListUI();
    };

    UI.addBtn.onclick = async () => {
        const val = UI.input.value.trim();
        if (!val && STATE.currentInputMode !== 'search_local') return;
        
        const originalText = UI.addBtn.textContent;
        UI.addBtn.textContent = '...';
        UI.addBtn.disabled = true;

        if (STATE.currentInputMode === 'search_local') {
            STATE.localSearchKeyword = val.toLowerCase();
            renderListUI();
            UI.addBtn.textContent = originalText;
            UI.addBtn.disabled = false;
            return;
        }

        if (STATE.currentInputMode === 'search') {
            const results = await API.searchTrack(val);
            if (results.length > 0) {
                STATE.searchResults = results;
                STATE.isShowingSearch = true;
                renderListUI();
                API.toast(`搜索到 ${results.length} 首相关歌曲`);
            } else {
                API.toast("未搜索到结果，请换个关键词");
            }
        } else {
            const tracks = await API.parsePlaylist(val, STATE.currentInputMode);
            if (tracks.length > 0) {
                const currentListObj = getCurrentPlaylist();
                
                // 防卡死：导入时检查容量
                if (currentListObj.tracks.length >= CONFIG.MAX_TRACKS_PER_LIST) {
                    API.toast(`歌单已达到上限 (${CONFIG.MAX_TRACKS_PER_LIST}首)，无法继续导入`);
                    UI.addBtn.textContent = originalText;
                    UI.addBtn.disabled = false;
                    return;
                }

                const existingKeys = new Set(currentListObj.tracks.map(trackDedupeKey));
                let newTracks = tracks.filter(t => !existingKeys.has(trackDedupeKey(t)));
                const dupeCount = tracks.length - newTracks.length;
                
                // 截断超出的部分
                let limitCount = 0;
                if (currentListObj.tracks.length + newTracks.length > CONFIG.MAX_TRACKS_PER_LIST) {
                    const allowed = CONFIG.MAX_TRACKS_PER_LIST - currentListObj.tracks.length;
                    limitCount = newTracks.length - allowed;
                    newTracks = newTracks.slice(0, allowed);
                }

                currentListObj.tracks.push(...newTracks);
                savePlaylist();
                STATE.isShowingSearch = false;
                renderListUI();
                UI.input.value = '';
                
                let msg = `成功导入 ${newTracks.length} 首歌曲至 [${currentListObj.name}]`;
                if (dupeCount > 0) msg += `（跳过 ${dupeCount} 首重复）`;
                if (limitCount > 0) msg += `（因容量限制，截断了 ${limitCount} 首）`;
                API.toast(msg);
                
                if (STATE.currentIndex === -1 && STATE.playingPlaylistId === currentListObj.id) {
                    playTrack(0, currentListObj.id);
                }
            } else {
                API.toast("歌单解析失败或为空，请检查ID权限");
            }
        }
        
        UI.addBtn.textContent = originalText;
        UI.addBtn.disabled = false;
    };

    UI.input.onkeypress = (e) => {
        if (e.key === 'Enter') UI.addBtn.click();
    };
    UI.input.oninput = () => {
        if (STATE.currentInputMode === 'search_local') {
            STATE.localSearchKeyword = UI.input.value.trim().toLowerCase();
            renderListUI();
        }
    };

    const THEME_DEFAULT_COLORS = {
        adaptive: '', // 自适应主题不强制设色，跟随宿主环境
        light: '#000000',
        dark: '#ffffff',
        glass: '#ffffff'
    };

    UI.themeDots.forEach(dot => {
        dot.onclick = () => {
            UI.themeDots.forEach(d => d.classList.remove('active'));
            dot.classList.add('active');
            STATE.currentTheme = dot.dataset.theme;
            savedSettings.theme = STATE.currentTheme;
            UI.wrapper.className = `theme-${STATE.currentTheme}`;
            
            // 切换主题时，恢复该主题的默认强调色
            const defColor = THEME_DEFAULT_COLORS[STATE.currentTheme];
            if (defColor) {
                savedSettings.customColor = defColor;
                UI.colorPicker.value = defColor;
            }
            applySettings();
        };
    });

    UI.shapeBtn.onclick = () => {
        savedSettings.shapeStyle = savedSettings.shapeStyle === 'square' ? 'round' : 'square';
        applySettings();
    };

    let settingsSaveTimer = null;
    const saveSettings = () => {
        try {
            localStorage.setItem(CONFIG.SETTINGS_KEY, JSON.stringify(savedSettings));
        } catch (e) {
            if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
                API.toast("保存失败：图片体积过大，超出了浏览器本地存储限制。请清除壁纸或装修小图后重试。");
                savedSettings.nowCoverImage = '';
                if (UI.nowCover) {
                    UI.nowCover.replaceChildren();
                    const icon = targetWin.document.createElement('i');
                    icon.className = 'fas fa-compact-disc';
                    UI.nowCover.appendChild(icon);
                }
                if (UI.decorationPreviewCover) {
                    UI.decorationPreviewCover.replaceChildren();
                    const icon = targetWin.document.createElement('i');
                    icon.className = 'fas fa-compact-disc';
                    UI.decorationPreviewCover.appendChild(icon);
                }
                savedSettings.bgImage = '';
                UI.wrapper.style.setProperty('--fm-bg-image', 'none');
            }
        }
    };
    const scheduleSettingsSave = () => {
        clearTimeout(settingsSaveTimer);
        settingsSaveTimer = setTimeout(saveSettings, 250);
    };

    const applyDecoration = () => {
        const label = String(savedSettings.nowPlayingLabel || '').trim() || 'NOW PLAYING';
        if (UI.nowPlayingLabel) UI.nowPlayingLabel.textContent = label;

        const renderCover = (container) => {
            if (!container) return;
            container.replaceChildren();
            if (savedSettings.nowCoverImage) {
                const img = targetWin.document.createElement('img');
                img.src = savedSettings.nowCoverImage;
                img.alt = '';
                img.draggable = false;
                container.appendChild(img);
            } else {
                const icon = targetWin.document.createElement('i');
                icon.className = 'fas fa-compact-disc';
                container.appendChild(icon);
            }
        };

        renderCover(UI.nowCover);
        renderCover(UI.decorationPreviewCover);
    };

    const readSmallImage = (file, maxSize = 256) => new Promise((resolve, reject) => {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            reject(new Error('NOT_IMAGE'));
            return;
        }
        if (file.size > 8 * 1024 * 1024) {
            reject(new Error('TOO_LARGE'));
            return;
        }

        const reader = new FileReader();
        reader.onerror = () => reject(new Error('READ_FAILED'));
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const longest = Math.max(img.naturalWidth || 1, img.naturalHeight || 1);
                const scale = Math.min(1, maxSize / longest);
                const width = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
                const height = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
                const canvas = targetWin.document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    reject(new Error('CANVAS_FAILED'));
                    return;
                }
                ctx.drawImage(img, 0, 0, width, height);
                const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                try {
                    resolve(canvas.toDataURL(outputType, outputType === 'image/jpeg' ? 0.82 : undefined));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => reject(new Error('IMAGE_FAILED'));
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });

    const applySettings = (persist = true) => {

        UI.wrapper.style.setProperty('--fm-ball-size', `${savedSettings.ballSize}px`);
        UI.ballVisibleToggle.checked = savedSettings.showBall !== false;
        UI.wrapper.classList.toggle('ball-hidden', savedSettings.showBall === false);
        UI.wrapper.style.setProperty('--fm-custom-color', savedSettings.customColor);
        
        if (savedSettings.shapeStyle === 'square') {
            UI.wrapper.style.setProperty('--fm-radius-ball', '8px');
            UI.wrapper.style.setProperty('--fm-radius-panel', '0px');
            UI.wrapper.style.setProperty('--fm-radius-btn', '4px');
            UI.wrapper.style.setProperty('--fm-radius-input', '0px');
            UI.wrapper.style.setProperty('--fm-radius-thumb', '2px');
            UI.shapeBtn.innerHTML = '<i class="fas fa-circle"></i>';
            UI.shapeBtn.title = "切换为圆润外观";
        } else {
            UI.wrapper.style.setProperty('--fm-radius-ball', '50%');
            UI.wrapper.style.setProperty('--fm-radius-panel', '24px');
            UI.wrapper.style.setProperty('--fm-radius-btn', '50%');
            UI.wrapper.style.setProperty('--fm-radius-input', '8px');
            UI.wrapper.style.setProperty('--fm-radius-thumb', '50%');
            UI.shapeBtn.innerHTML = '<i class="fas fa-square"></i>';
            UI.shapeBtn.title = "切换为方正外观";
        }
        
        if (savedSettings.bgImage) {
            UI.wrapper.style.setProperty('--fm-bg-image', `url(${savedSettings.bgImage})`);
        } else {
            UI.wrapper.style.setProperty('--fm-bg-image', 'none');
        }
        UI.wrapper.style.setProperty('--fm-bg-blur', `${savedSettings.bgBlur}px`);
        UI.wrapper.style.setProperty('--fm-bg-brightness', `${savedSettings.bgBrightness}%`);
        UI.wrapper.style.setProperty('--fm-lrc-font', `${savedSettings.lrcFont}px`);
        UI.wrapper.style.setProperty('--fm-lrc-bottom', `${savedSettings.lrcBottom}px`);

        // 修复：面板比例应用逻辑
        if (savedSettings.panelRatio === '3:4') {
            UI.ratioBtn.innerHTML = '<i class="fas fa-crop-alt"></i> 3:4';
        } else if (savedSettings.panelRatio === '9:16') {
            UI.ratioBtn.innerHTML = '<i class="fas fa-crop-alt"></i> 9:16';
        } else {
            UI.ratioBtn.innerHTML = '<i class="fas fa-crop-alt"></i> 自适应';
        }

        // 智能强调色应用逻辑：
        // 如果用户自定义的颜色与当前主题默认色不同，则应用覆盖；否则移除内联样式，让CSS接管。
        const defColor = THEME_DEFAULT_COLORS[STATE.currentTheme];
        if (STATE.currentTheme !== 'adaptive' && savedSettings.customColor && savedSettings.customColor !== defColor) {
            UI.wrapper.style.setProperty('--fm-accent', savedSettings.customColor);
        } else {
            UI.wrapper.style.removeProperty('--fm-accent');
        }
        
        applyDecoration();
        if (persist) saveSettings();
    };

    UI.sizeSlider.value = savedSettings.ballSize;
    UI.colorPicker.value = savedSettings.customColor;
    UI.bgBlurSlider.value = savedSettings.bgBlur;
    UI.bgBrightnessSlider.value = savedSettings.bgBrightness;
    UI.lrcFontSlider.value = savedSettings.lrcFont;
    UI.lrcBottomSlider.value = savedSettings.lrcBottom;
    UI.decorationLabelInput.value = savedSettings.nowPlayingLabel || 'NOW PLAYING';
    applySettings();

    const updateLrcModeBtns = () => {
        UI.lrcModePlainBtn.classList.toggle('active', savedSettings.lrcMode === 'plain');
        UI.lrcModePopupBtn.classList.toggle('active', savedSettings.lrcMode === 'popup');
        UI.lrcModeScrollBtn.classList.toggle('active', savedSettings.lrcMode === 'scroll');
        UI.lrcModeFallBtn.classList.toggle('active', savedSettings.lrcMode === 'fall');
    };
    updateLrcModeBtns();
    syncLyricsVisibility();

    UI.sizeSlider.oninput = (e) => {
        savedSettings.ballSize = e.target.value;
        applySettings(false);
        scheduleSettingsSave();
    };

    UI.ballVisibleToggle.onchange = (e) => {
        savedSettings.showBall = !!e.target.checked;
        applySettings();
    };

    UI.colorPicker.oninput = (e) => {
        savedSettings.customColor = e.target.value;
        applySettings(false);
        scheduleSettingsSave();
    };

    UI.decorationUploadBtn.onclick = () => UI.decorationUploadInput.click();

    UI.decorationUploadInput.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            savedSettings.nowCoverImage = await readSmallImage(file, 256);
            applySettings();
            API.toast('播放器装修小图已更新');
        } catch (err) {
            if (err && err.message === 'TOO_LARGE') {
                API.toast('图片原文件太大，请选择 8MB 以内的图片。');
            } else {
                API.toast('图片读取失败，请换一张图片重试。');
            }
        } finally {
            UI.decorationUploadInput.value = '';
        }
    };

    UI.decorationClearBtn.onclick = () => {
        savedSettings.nowCoverImage = '';
        applySettings();
        API.toast('已恢复默认唱片图标');
    };

    UI.decorationLabelInput.oninput = (e) => {
        savedSettings.nowPlayingLabel = e.target.value.slice(0, 24);
        applyDecoration();
        scheduleSettingsSave();
    };

    UI.bgUploadBtn.onclick = () => UI.bgUploadInput.click();
    
    UI.bgUploadInput.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = (event) => {
            const imgData = event.target.result;
            const tempImg = new Image();
            tempImg.onload = () => {
                savedSettings.bgImage = imgData;
                savedSettings.bgImageWidth = tempImg.naturalWidth;
                savedSettings.bgImageHeight = tempImg.naturalHeight;
                applySettings();
                
                if (STATE.isExpanded && savedSettings.panelRatio === 'default') {
                    // 强制重新计算高度
                    togglePanel();
                    togglePanel();
                }
            };
            tempImg.src = imgData;
            UI.bgUploadInput.value = '';
        };
        reader.readAsDataURL(file);
    };

    UI.bgClearBtn.onclick = () => {
        savedSettings.bgImage = '';
        savedSettings.bgImageWidth = 0;
        savedSettings.bgImageHeight = 0;
        applySettings();
        
        if (STATE.isExpanded && savedSettings.panelRatio === 'default') {
            togglePanel();
            togglePanel();
        }
    };

    UI.ratioBtn.onclick = () => {
        const ratios = ['default', '3:4', '9:16'];
        let idx = ratios.indexOf(savedSettings.panelRatio);
        idx = (idx + 1) % ratios.length;
        savedSettings.panelRatio = ratios[idx];
        applySettings();
        
        if (STATE.isExpanded) {
            // 强制重新计算高度和位置
            togglePanel();
            togglePanel();
        }
    };

    UI.bgBlurSlider.oninput = (e) => {
        savedSettings.bgBlur = e.target.value;
        applySettings();
    };

    UI.bgBrightnessSlider.oninput = (e) => {
        savedSettings.bgBrightness = e.target.value;
        applySettings();
    };

    audio.onplay = () => {
        STATE.isPlaying = true;
        UI.playBtn.innerHTML = '<i class="fas fa-pause"></i>';
        UI.ball.classList.add('playing');
        if (lrcRafId) cancelAnimationFrame(lrcRafId);
        updateLyrics();
    };
    audio.onpause = () => {
        STATE.isPlaying = false;
        UI.playBtn.innerHTML = '<i class="fas fa-play"></i>';
        UI.ball.classList.remove('playing');
        if (lrcRafId) cancelAnimationFrame(lrcRafId);
    };
    audio.onended = () => {
        if (STATE.playMode === 'repeat_one') { audio.currentTime = 0; audio.play(); }
        else playNext();
    };
    audio.ontimeupdate = () => {
        if (!STATE.isSeekingProgress) updateProgressUI(audio.currentTime, audio.duration);
        if (STATE.isLyricsVisible) updateLyrics();
    };
    audio.onloadedmetadata = () => { if (!STATE.isSeekingProgress) updateProgressUI(audio.currentTime, audio.duration); };
    audio.onerror = () => {
        const failedIndex = STATE.currentIndex;
        const failedToken = audio.__playToken;
        if (failedIndex < 0 || !audio.src || failedToken !== STATE.playRequestId) return;
        const list = STATE.playlists.find(p => p.id === STATE.playingPlaylistId);
        const track = list && list.tracks[failedIndex];
        if (!track) return;

        if (track.__retriedOnError) {
            console.warn('[АрⅤ] 播放失败，重新解析后仍无法播放', track.title);
            return;
        }

        track.__retriedOnError = true;
        track.url = null; 
        console.warn('[АрⅤ] 播放失败，尝试重新解析音源后自动重试一次', track.title);
        playTrack(failedIndex, STATE.playingPlaylistId, true);
    };

    // ================= SillyTavern 扩展菜单入口 =================
    function installSillyTavernWandButton() {
        const doc = targetDoc;
        if (!doc) return false;
        const menu = doc.querySelector('#extensionsMenu');
        if (!menu) return false;

        const old = doc.querySelector('#arv_terminal_wand_container');
        if (old) old.remove();

        const container = doc.createElement('div');
        container.id = 'arv_terminal_wand_container';
        container.className = 'extension_container';

        const item = doc.createElement('div');
        item.id = 'arvTerminalExtensionMenuItem';
        item.className = 'list-group-item flex-container flexGap5';
        item.title = '打开 АрⅤ Terminal 音乐播放器';
        item.innerHTML = '<div class="fa-fw fa-solid fa-music extensionsMenuExtensionButton"></div><span>АрⅤ播放器</span>';

        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!STATE.isExpanded) togglePanel();
        });

        container.appendChild(item);
        menu.appendChild(container);
        return true;
    }

    function openFromSillyTavernMenu() {
        if (!STATE.isExpanded) togglePanel();
    }

    // ================= 初始化 =================
    initDraggable();
    initProgressBar();
    renderListUI(); 
    
    if (startupDedupeCount > 0 || startupLimitCount > 0) {
        let msg = `[优化] 启动清理完成：`;
        if (startupDedupeCount > 0) msg += `移除 ${startupDedupeCount} 首重复歌曲。`;
        if (startupLimitCount > 0) msg += `截断 ${startupLimitCount} 首超出容量限制的歌曲。`;
        API.toast(msg);
    }
    
    targetWin._flowMusicToggle = () => {
        savedSettings.showBall = savedSettings.showBall === false;
        applySettings();
    };

    if (typeof eventOn === 'function' && typeof getButtonEvent === 'function') {
        eventOn(getButtonEvent('显隐播放器'), targetWin._flowMusicToggle);
    }

    // SillyTavern 的输入框扩展菜单（扳手/魔法棒菜单）只需要放一个入口，
    // 点击入口后打开播放器自己的完整面板，不把播放器 UI 塞进菜单。
    if (!installSillyTavernWandButton()) {
        const retry = setInterval(() => {
            if (installSillyTavernWandButton()) clearInterval(retry);
        }, 500);
        setTimeout(() => clearInterval(retry), 15000);
    }

    targetWin.addEventListener('pagehide', () => {
        if (audio) { audio.pause(); audio.src = ''; audio = null; }
        if (lrcRafId) cancelAnimationFrame(lrcRafId);
        saveSettings();
        clearTimeout(settingsSaveTimer);
        const c = targetDoc.getElementById(CONFIG.ID);
        if (c) c.remove();
        delete targetWin._flowMusicToggle;
    });

})();

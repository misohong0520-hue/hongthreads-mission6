// interceptor.js - DReaThs API Interceptor + Data Scanner v1.60
// MAIN world에서 실행: GraphQL 인터셉트 + React Fiber 서브트리 스캔 + 미디어(동영상/캐러셀/이미지) 정밀 캐싱

(function() {
    window.__DREATHE_MEDIA_CACHE__ = window.__DREATHE_MEDIA_CACHE__ || {};

    // ===== 데이터 전송 =====
    const sendData = (type, payload) => {
        try {
            window.postMessage({ type: type, ...payload }, '*');
        } catch(e) {}
    };

    // Meta API의 "for (;;);" 접두사 제거
    const cleanJson = (text) => {
        if (!text) return text;
        if (text.startsWith('for (;;);')) return text.substring(9);
        return text;
    };

    // 오디오 전용 스트림(MP4 컨테이너의 오디오 전용 트랙 등) 정밀 감지 헬퍼
    // 주의: 일반 비디오 파일명 끝이 우연히 '_a.mp4'이거나 progressive 비디오 태그에 audio가 병기된 경우를 오탐하지 않도록 정밀 판별
    const isAudioUrl = (url) => {
        if (!url || typeof url !== 'string') return false;
        const lower = url.toLowerCase();
        if (lower.includes('_audio_dashinit') || 
            lower.includes('audio_dashinit') ||
            lower.includes('dash_ln_heaac') ||
            lower.includes('vbr3_audio') ||
            lower.includes('dash_audio') ||
            lower.includes('/audio/') ||
            lower.includes('mime_type=audio') ||
            lower.includes('audio%2fmp4')) {
            return true;
        }
        try {
            const efgMatch = url.match(/[?&]efg=([^&]+)/);
            if (efgMatch && efgMatch[1]) {
                const decoded = decodeURIComponent(efgMatch[1]);
                const jsonStr = atob(decoded);
                const efgObj = JSON.parse(jsonStr);
                const tag = (efgObj.vencode_tag || '').toLowerCase();
                const hasVideoCodec = tag.includes('progressive') || tag.includes('vp9') || tag.includes('av1') ||
                                      tag.includes('h264') || tag.includes('c264') || tag.includes('hevc') ||
                                      tag.includes('720') || tag.includes('1080') || tag.includes('480') || tag.includes('360');
                if (!hasVideoCodec && (tag.includes('audio') || tag.includes('heaac') || tag.includes('aac'))) {
                    return true;
                }
            }
        } catch(e) {}
        return false;
    };

    // 영상과 음성이 결합된 Progressive 동영상 감지 헬퍼
    const isProgressiveVideoUrl = (url) => {
        if (!url || typeof url !== 'string' || isAudioUrl(url)) return false;
        const lower = url.toLowerCase();
        if (lower.includes('xpv_progressive') || lower.includes('progressive_download') || lower.includes('progressive_recipe')) return true;
        try {
            const efgMatch = url.match(/[?&]efg=([^&]+)/);
            if (efgMatch && efgMatch[1]) {
                const decoded = decodeURIComponent(efgMatch[1]);
                const jsonStr = atob(decoded);
                const efgObj = JSON.parse(jsonStr);
                const tag = (efgObj.vencode_tag || '').toLowerCase();
                if (tag.includes('progressive')) return true;
            }
        } catch(e) {}
        return false;
    };

    // CDN 동영상 URL에서 부분 청크 파라미터(bytestart, byteend) 제거
    const cleanVideoUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        let clean = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
        clean = clean
            .replace(/([?&])bytestart=\d+(&|$)/g, '$1')
            .replace(/([?&])byteend=\d+(&|$)/g, '$1')
            .replace(/[?&]+$/, '')
            .replace(/\?&/, '?');
        return clean;
    };

    // DASH Manifest XML에서 비디오 전용 AdaptationSet 추출 헬퍼 (오디오 절대 제외)
    const extractVideoFromDashManifest = (manifest) => {
        if (typeof manifest !== 'string' || !manifest.includes('<BaseURL>')) return null;
        const clean = manifest.replace(/\\u003C/gi, '<').replace(/\\u003E/gi, '>').replace(/\\u0026/gi, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
        
        // contentType="video" 또는 mimeType="video/mp4" 영역만 정확히 격리
        const videoAdaptationMatch = clean.match(/<AdaptationSet[^>]*?(?:contentType="video"|mimeType="video\/mp4")[^>]*?>([\s\S]*?)<\/AdaptationSet>/i);
        const searchScope = videoAdaptationMatch ? videoAdaptationMatch[1] : clean;
        
        const repMatches = [...searchScope.matchAll(/<Representation([^>]*?)>([\s\S]*?)<\/Representation>/gi)];
        let bestUrl = null;
        let maxQuality = -1;
        
        for (const rm of repMatches) {
            const attrs = rm[1];
            const body = rm[2];
            const baseMatch = body.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
            if (!baseMatch || !baseMatch[1] || !baseMatch[1].startsWith('http')) continue;
            const candidateUrl = cleanVideoUrl(baseMatch[1].trim());
            if (isAudioUrl(candidateUrl)) continue;
            
            const widthMatch = attrs.match(/width="(\d+)"/i);
            const heightMatch = attrs.match(/height="(\d+)"/i);
            const bwMatch = attrs.match(/bandwidth="(\d+)"/i);
            const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
            const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
            const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
            const score = (width * height) > 0 ? (width * height) : bw;
            
            if (score > maxQuality) {
                maxQuality = score;
                bestUrl = candidateUrl;
            }
        }
        
        if (bestUrl) return bestUrl;
        
        if (videoAdaptationMatch) {
            const m = videoAdaptationMatch[1].match(/<BaseURL>([^<]+)<\/BaseURL>/i);
            if (m && m[1] && m[1].startsWith('http')) {
                const candidateUrl = cleanVideoUrl(m[1].trim());
                if (!isAudioUrl(candidateUrl)) return candidateUrl;
            }
        }
        return null;
    };

    // 객체/props에서 최적의 비디오 URL 추출 (Meta Comet OzPlayer / Relay / video_versions / DASH 지원)
    const extractVideoUrl = (obj, depth = 0, visited = null) => {
        if (!obj || typeof obj !== 'object' || depth > 4) return null;
        if (!visited) visited = new WeakSet();
        if (visited.has(obj)) return null;
        visited.add(obj);

        const isValidVideoCandidate = (u) => {
            return typeof u === 'string' && u.startsWith('http') && !u.includes('rsrc.php') && !u.includes('static.cdninstagram.com') && !isAudioUrl(u);
        };

        // 1. video_versions / videoVersions 배열 (Progressive 우선 + 고화질 우선 정렬)
        const vVers = obj.video_versions || obj.videoVersions ||
                      obj.clips_metadata?.video_versions || obj.clips_metadata?.videoVersions ||
                      obj.video?.video_versions || obj.video?.videoVersions ||
                      obj.media?.video_versions || obj.media?.videoVersions ||
                      obj.post?.video_versions || obj.post?.videoVersions;
        if (Array.isArray(vVers) && vVers.length > 0) {
            const sorted = [...vVers].sort((a, b) => {
                const uA = a?.url || a?.uri || a?.src || '';
                const uB = b?.url || b?.uri || b?.src || '';
                const pA = isProgressiveVideoUrl(uA) ? 1 : 0;
                const pB = isProgressiveVideoUrl(uB) ? 1 : 0;
                if (pA !== pB) return pB - pA;
                const qA = (a?.width && a?.height) ? (a.width * a.height) : (a?.height || 0);
                const qB = (b?.width && b?.height) ? (b.width * b.height) : (b?.height || 0);
                return qB - qA;
            });
            for (const v of sorted) {
                const u = v?.url || v?.uri || v?.src || v?.playback_url || v?.playbackUrl;
                if (isValidVideoCandidate(u)) {
                    return cleanVideoUrl(u);
                }
            }
        }

        // 2. Meta Comet VideoDeliveryResponseResult (progressive_urls / dash_manifests)
        const delivery = obj.videoDeliveryResponseResult || obj.video_delivery_response_result ||
                         obj.videoDeliveryResponse?.videoDeliveryResponseResult;
        if (delivery && typeof delivery === 'object') {
            const progUrls = delivery.progressive_urls || delivery.progressiveUrls;
            if (Array.isArray(progUrls)) {
                const sortedProg = [...progUrls].sort((a, b) => {
                    const hdA = (a?.metadata?.quality === 'HD' || a?.quality === 'HD') ? 1 : 0;
                    const hdB = (b?.metadata?.quality === 'HD' || b?.quality === 'HD') ? 1 : 0;
                    return hdB - hdA;
                });
                for (const pu of sortedProg) {
                    const u = pu?.progressive_url || pu?.progressiveUrl || pu?.url || pu?.uri;
                    if (isValidVideoCandidate(u)) return cleanVideoUrl(u);
                }
            }
            const dashList = delivery.dash_manifests || delivery.dashManifests;
            if (Array.isArray(dashList)) {
                for (const dm of dashList) {
                    const xml = dm?.manifest_xml || dm?.manifestXml || dm?.manifest;
                    const dUrl = extractVideoFromDashManifest(xml);
                    if (dUrl) return dUrl;
                }
            }
        }

        // 3. Meta Comet Player implementations 배열
        if (Array.isArray(obj.implementations)) {
            for (const impl of obj.implementations) {
                const d = impl?.data || impl;
                if (d && typeof d === 'object') {
                    const u = extractVideoUrl(d, depth + 1, visited);
                    if (u) return u;
                }
            }
        }

        // 4. progressive_urls / progressiveUrls 배열 직접 체크
        const progArr = obj.progressive_urls || obj.progressiveUrls;
        if (Array.isArray(progArr)) {
            for (const pItem of progArr) {
                const u = typeof pItem === 'string' ? pItem : (pItem?.progressive_url || pItem?.progressiveUrl || pItem?.url || pItem?.uri);
                if (isValidVideoCandidate(u)) return cleanVideoUrl(u);
            }
        }

        // 5. 단일 URL 프로퍼티들 (HD 우선)
        const directKeys = [
            'playable_url_quality_hd', 'playableUrlQualityHd',
            'browser_native_hd_url', 'browserNativeHdUrl',
            'hdSrcNoRatelimit', 'hd_src_no_ratelimit',
            'hdSrc', 'hd_src',
            'progressive_download_url', 'progressiveDownloadUrl',
            'progressive_url', 'progressiveUrl',
            'playback_url', 'playbackUrl',
            'playable_url', 'playableUrl',
            'browser_native_sd_url', 'browserNativeSdUrl',
            'sdSrcNoRatelimit', 'sd_src_no_ratelimit',
            'sdSrc', 'sd_src',
            'video_url', 'videoUrl',
            'video_src', 'videoSrc',
            'src'
        ];
        for (const key of directKeys) {
            const val = obj[key];
            if (isValidVideoCandidate(val) && (key !== 'src' || val.includes('.mp4') || val.includes('/v/t') || val.includes('/o1/v/'))) {
                return cleanVideoUrl(val);
            }
            for (const sub of ['video', 'media', 'post', 'videoData', 'video_data', 'playerConfig', 'videoSpec']) {
                if (obj[sub] && typeof obj[sub] === 'object') {
                    const subVal = obj[sub][key];
                    if (isValidVideoCandidate(subVal) && (key !== 'src' || subVal.includes('.mp4') || subVal.includes('/v/t') || subVal.includes('/o1/v/'))) {
                        return cleanVideoUrl(subVal);
                    }
                }
            }
        }

        // 6. videoData.urls 배열
        const vDataUrls = obj.videoData?.urls || obj.video_data?.urls;
        if (Array.isArray(vDataUrls)) {
            for (const u of vDataUrls) {
                if (isValidVideoCandidate(u)) return cleanVideoUrl(u);
            }
        }

        // 7. DASH Manifest XML 내 BaseURL 추출
        const manifest = obj.video_dash_manifest || obj.dash_manifest || obj.dashManifest || obj.videoDashManifest || obj.manifest_xml || obj.manifestXml || obj.manifest;
        if (typeof manifest === 'string') {
            const dashVideo = extractVideoFromDashManifest(manifest);
            if (dashVideo) return dashVideo;
        }

        // 8. 제한된 깊이로 하위 미디어/플레이어 컨테이너 탐색 (다른 포스트나 캐러셀 배열로는 절대 진입하지 않음)
        if (depth < 3) {
            const safeSubKeys = ['video', 'media', 'item', 'node', 'data', 'playerConfig', 'videoSpec', 'clips_metadata', ' videoData', 'video_data', 'mediaData', 'attachment'];
            for (const k of safeSubKeys) {
                const subObj = obj[k];
                if (subObj && typeof subObj === 'object' && !Array.isArray(subObj)) {
                    const u = extractVideoUrl(subObj, depth + 1, visited);
                    if (u) return u;
                }
            }
        }

        return null;
    };

    // 이미지 후보 추출 헬퍼
    const extractBestImageUrl = (item) => {
        if (!item || typeof item !== 'object') return null;
        if (Array.isArray(item.image_versions2?.candidates) && item.image_versions2.candidates.length > 0) {
            const sorted = [...item.image_versions2.candidates].sort((a, b) => {
                const qA = (a?.width && a?.height) ? (a.width * a.height) : (a?.width || 0);
                const qB = (b?.width && b?.height) ? (b.width * b.height) : (b?.width || 0);
                return qB - qA;
            });
            const u = sorted[0]?.url || item.image_versions2.candidates[0]?.url;
            if (typeof u === 'string' && u.startsWith('http') && !u.includes('rsrc.php')) return u;
        }
        if (Array.isArray(item.image_versions) && item.image_versions.length > 0) {
            const u = item.image_versions[0]?.url;
            if (typeof u === 'string' && u.startsWith('http') && !u.includes('rsrc.php')) return u;
        }
        for (const k of ['display_url', 'displayUrl', 'thumbnail_url', 'thumbnailUrl', 'image_url', 'imageUrl']) {
            if (typeof item[k] === 'string' && item[k].startsWith('http') && !item[k].includes('rsrc.php')) {
                return item[k];
            }
        }
        if (typeof item.image?.uri === 'string' && item.image.uri.startsWith('http')) return item.image.uri;
        return null;
    };

    // 단일 미디어 객체가 비디오인지 판별
    const isMediaObjectKnownVideo = (obj) => {
        if (!obj || typeof obj !== 'object') return false;
        return obj.media_type === 2 ||
               obj.media_type === '2' ||
               obj.media_type === 'VIDEO' ||
               obj.is_video === true ||
               (obj.video_duration !== undefined && Number(obj.video_duration) > 0) ||
               !!obj.clips_metadata ||
               (Array.isArray(obj.video_versions) && obj.video_versions.length > 0) ||
               (Array.isArray(obj.videoVersions) && obj.videoVersions.length > 0) ||
               !!obj.video_dash_manifest ||
               !!obj.dash_manifest ||
               !!obj.dashManifest ||
               !!obj.videoDeliveryResponseResult ||
               !!obj.video_delivery_response_result;
    };

    // 포스트 객체에서 미디어(비디오, 이미지, 캐러셀) 추출 헬퍼
    const extractMediaFromPost = (postObj) => {
        if (!postObj || typeof postObj !== 'object') return [];
        const items = [];
        const seen = new Set();

        const isKnownVideo = isMediaObjectKnownVideo(postObj);

        // 1. 캐러셀 미디어 (슬라이드형 다중 이미지/비디오)
        const carousel = postObj.carousel_media ||
                         postObj.carouselMedia ||
                         postObj.carousel_items ||
                         postObj.carouselItems ||
                         postObj.edge_sidecar_to_children?.edges ||
                         postObj.sidecar_children ||
                         postObj.text_post_app_info?.linked_inline_media?.carousel_media;

        if (Array.isArray(carousel) && carousel.length > 0) {
            carousel.forEach((rawItem, idx) => {
                const item = rawItem?.node || rawItem?.media || rawItem;
                if (!item || typeof item !== 'object') return;

                const itemIsExplicitImage = item.media_type === 1 || item.media_type === '1' || item.media_type === 'PHOTO' ||
                                            item.is_video === false || item.__typename === 'XDTGraphImage' || item.__typename === 'GraphImage';
                const bestVideo = itemIsExplicitImage ? null : extractVideoUrl(item);
                const bestImg = extractBestImageUrl(item);
                const itemIsVideo = !itemIsExplicitImage && (isMediaObjectKnownVideo(item) || !!bestVideo);
                const dedupKey = item.pk || item.id || bestVideo || bestImg || `slide_${idx}`;

                if (bestVideo && !seen.has(bestVideo)) {
                    seen.add(bestVideo);
                    seen.add(dedupKey);
                    items.push({ type: 'video', url: bestVideo, thumbnail_url: bestImg || bestVideo });
                } else if (itemIsVideo && !seen.has(dedupKey)) {
                    seen.add(dedupKey);
                    items.push({ type: 'video', url: '', thumbnail_url: bestImg || '' });
                } else if (!itemIsVideo && bestImg && !seen.has(bestImg)) {
                    seen.add(bestImg);
                    seen.add(dedupKey);
                    items.push({ type: 'image', url: bestImg });
                }
            });
            if (items.length > 0) {
                return items;
            }
        }

        // 2. 단일 비디오
        const bestVideo = extractVideoUrl(postObj);
        const bestImg = extractBestImageUrl(postObj);
        if (bestVideo) {
            if (!seen.has(bestVideo)) {
                seen.add(bestVideo);
                items.push({ type: 'video', url: bestVideo, thumbnail_url: bestImg || bestVideo });
            }
            return items;
        }

        // 3. 단일 이미지
        // 중요: isKnownVideo이거나 캐러셀 포스트(media_type === 8)인 경우,
        // 부분 Relay fragment의 대표 썸네일(image_versions2 1장)만 추출하여 비디오/캐러셀을 덮어쓰는 현상 원천 차단!
        const isKnownCarousel = postObj.media_type === 8 || postObj.media_type === '8' || postObj.media_type === 'CAROUSEL_ALBUM' ||
                                (postObj.carousel_media_count !== undefined && Number(postObj.carousel_media_count) > 1);
        if (items.length === 0 && !isKnownVideo && !isKnownCarousel && bestImg) {
            if (!seen.has(bestImg)) {
                seen.add(bestImg);
                items.push({ type: 'image', url: bestImg });
            }
        }

        return items;
    };

    // 미디어 배열의 품질 점수 계산 (다중 캐러셀 및 비디오가 단일 썸네일 이미지로 다운그레이드되는 것 방지)
    const calcMediaQualityScore = (items) => {
        if (!Array.isArray(items) || items.length === 0) return 0;
        const validItems = items.filter(m => m && m.url);
        if (validItems.length === 0) return 0;
        const videoCount = validItems.filter(m => m.type === 'video' && !isAudioUrl(m.url)).length;
        const progCount = validItems.filter(m => m.type === 'video' && isProgressiveVideoUrl(m.url)).length;
        if (validItems.length > 1) {
            return validItems.length * 1000 + videoCount * 200 + progCount * 30;
        }
        return 100 + videoCount * 500 + progCount * 50;
    };

    const mergeMediaIntoCache = (code, newItems, targetMap = null) => {
        if (!code || typeof code !== 'string' || !Array.isArray(newItems)) return false;
        const cleanNew = newItems.filter(m => m && m.url);
        if (cleanNew.length === 0) return false;
        const existing = window.__DREATHE_MEDIA_CACHE__[code];
        const newScore = calcMediaQualityScore(cleanNew);
        const existingScore = calcMediaQualityScore(existing);

        // 기존 캐시가 다중 캐러셀인데 단일 아이템이 들어온 경우: 절대 덮어쓰지 않음 (단, 미완성 비디오 슬롯 보강은 허용)
        if (existing && existing.length > 1 && cleanNew.length === 1) {
            if (cleanNew[0].type === 'video' && isProgressiveVideoUrl(cleanNew[0].url)) {
                let upgraded = false;
                const nextExisting = existing.map(item => {
                    if (!upgraded && item.type === 'video' && (!item.url || !isProgressiveVideoUrl(item.url))) {
                        upgraded = true;
                        return { ...item, url: cleanNew[0].url };
                    }
                    return item;
                });
                if (upgraded) {
                    window.__DREATHE_MEDIA_CACHE__[code] = nextExisting;
                    if (targetMap) targetMap[code] = nextExisting;
                    return true;
                }
            }
            if (targetMap && !targetMap[code]) targetMap[code] = existing;
            return false;
        }

        // 기존 캐시가 [이미지 + 비디오] 복합 캐러셀인데 새 배열이 동일 개수의 [비디오만]인 경우 덮어쓰기 차단
        if (existing && existing.length > 1 && cleanNew.length <= existing.length) {
            const existingHasImgAndVid = existing.some(m => m.type === 'image') && existing.some(m => m.type === 'video');
            const newHasOnlyVideo = cleanNew.every(m => m.type === 'video');
            if (existingHasImgAndVid && newHasOnlyVideo) {
                if (targetMap && !targetMap[code]) targetMap[code] = existing;
                return false;
            }
        }

        if (!existing || newScore >= existingScore) {
            window.__DREATHE_MEDIA_CACHE__[code] = cleanNew;
            if (targetMap) targetMap[code] = cleanNew;
            return true;
        }
        if (targetMap && !targetMap[code]) {
            targetMap[code] = existing;
        }
        return false;
    };

    const processInterceptedJson = (data) => {
        try {
            const mediaMap = {};
            const visited = new WeakSet();
            const traverse = (obj, depth = 0) => {
                if (!obj || typeof obj !== 'object' || depth > 150) return;
                if (visited.has(obj)) return;
                visited.add(obj);

                if (Array.isArray(obj)) {
                    for (let i = 0; i < obj.length; i++) {
                        traverse(obj[i], depth + 1);
                    }
                    return;
                }

                const objCode = obj.code || obj.shortcode;
                if (objCode && typeof objCode === 'string' && objCode.length > 3) {
                    const media = extractMediaFromPost(obj);
                    if (media.length > 0) {
                        mergeMediaIntoCache(objCode, media, mediaMap);
                    }
                }

                if (obj.post && typeof obj.post === 'object') traverse(obj.post, depth + 1);
                for (const k of Object.keys(obj)) {
                    if (k === 'post') continue;
                    const v = obj[k];
                    if (v && typeof v === 'object') traverse(v, depth + 1);
                }
            };
            traverse(data, 0);

            if (Object.keys(mediaMap).length > 0) {
                sendData('DREATHS_MEDIA_DATA', { media: mediaMap });
            }
        } catch(e) {}
    };

    const parseAndSend = (url, text) => {
        if (!text || text.length < 10) return;
        text = cleanJson(text);

        try {
            const data = JSON.parse(text);
            sendData('DREATHS_GRAPHQL_INTERCEPT', { url, data });
            processInterceptedJson(data);
            return;
        } catch(e) {}

        // 스트리밍 JSON
        const chunks = text.split('\n');
        for (const chunk of chunks) {
            const trimmed = cleanJson(chunk.trim());
            if (!trimmed || trimmed.length < 5) continue;
            try {
                const data = JSON.parse(trimmed);
                sendData('DREATHS_GRAPHQL_INTERCEPT', { url, data });
                processInterceptedJson(data);
            } catch(e2) {}
        }
    };

    const shouldIntercept = (url) => {
        if (!url || typeof url !== 'string') return false;
        return url.includes('graphql') || url.includes('/api/') ||
               url.includes('/ajax/') || url.includes('i.instagram.com');
    };

    // ===== fetch 인터셉트 =====
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        try {
            const url = args[0] instanceof Request ? args[0].url : (typeof args[0] === 'string' ? args[0] : '');
            if (shouldIntercept(url)) {
                const clone = response.clone();
                clone.text().then(text => parseAndSend(url, text)).catch(() => {});
            }
        } catch(e) {}
        return response;
    };

    // ===== XHR 인터셉트 =====
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._dreathsUrl = url;
        return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function(...args) {
        this.addEventListener('load', function() {
            try {
                if (shouldIntercept(this._dreathsUrl)) {
                    if (this.responseType === '' || this.responseType === 'text') {
                        parseAndSend(this._dreathsUrl, this.responseText);
                    }
                }
            } catch(e) {}
        });
        return originalSend.apply(this, args);
    };

    // ===== DOM 컨테이너에서 인용글(nested pressable)을 제외한 고유 postCode/author 엄격 추출 =====
    const extractStrictDomPostMeta = (cardEl) => {
        if (!cardEl || !cardEl.querySelectorAll) return { code: null, author: null };
        const nestedQuotes = Array.from(cardEl.querySelectorAll('[data-pressable-container="true"]')).filter(q => q !== cardEl);
        const isInsideQuote = (node) => nestedQuotes.some(q => q.contains(node));

        let code = null;
        let author = null;

        // 1순위: <time>을 감싸고 있는 퍼머링크 (게시글 본인의 고유 타임스탬프 링크)
        const links = Array.from(cardEl.querySelectorAll('a[href*="/post/"], a[href*="/t/"]')).filter(a => !isInsideQuote(a));
        const timeLinks = links.filter(a => !!a.querySelector('time'));
        const orderedLinks = [...timeLinks, ...links];

        for (const a of orderedLinks) {
            const href = a.getAttribute('href') || '';
            const pm = href.match(/\/@([^\/\?#]+)\/post\/([^\/\?#]+)/);
            if (pm) {
                author = pm[1].toLowerCase().trim();
                code = pm[2];
                break;
            }
            const tm = href.match(/\/(?:post|t)\/([^\/\?#]+)/);
            if (tm && !code) {
                code = tm[1];
            }
        }

        if (!author) {
            const authorLinks = Array.from(cardEl.querySelectorAll('a[href^="/@"], a[href*="threads.net/@"], a[href*="threads.com/@"]'))
                .filter(a => !isInsideQuote(a) && !(a.getAttribute('href') || '').includes('/post/'));
            for (const a of authorLinks) {
                const href = a.getAttribute('href') || '';
                const um = href.match(/@([a-zA-Z0-9._]+)/);
                if (um) {
                    author = um[1].toLowerCase().trim();
                    break;
                }
            }
        }

        return { code, author };
    };

    // DOM 요소에서 React Fiber 인스턴스 가져오기
    const getFiberFromEl = (el) => {
        if (!el || typeof el !== 'object') return null;
        const fKey = Object.keys(el).find(k =>
            k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
        );
        return fKey ? el[fKey] : null;
    };

    // 단일 <video> 요소에서 자신의 포스트 경계(parentCard)를 절대 벗어나지 않고 비디오 URL 추출
    const extractVideoUrlForVideoElement = (vid, parentCard, expectedPostCode = null) => {
        if (!vid) return { videoUrl: null, thumbUrl: null, postCode: expectedPostCode };

        let foundUrl = null;
        let foundThumb = vid.getAttribute('poster') || vid.poster || null;
        let foundCode = expectedPostCode || null;

        // 1순위: DOM <video> 요소의 실제 currentSrc / src (http MP4인 경우)
        const domSrc = vid.currentSrc || vid.getAttribute('src') || vid.src || vid.querySelector('source')?.src;
        if (domSrc && typeof domSrc === 'string' && domSrc.startsWith('http') && !domSrc.includes('rsrc.php') && !isAudioUrl(domSrc)) {
            foundUrl = cleanVideoUrl(domSrc);
        }

        // 2순위: vid에서 시작해 parentCard 내부에서만 React Fiber를 올라가며 스캔 (절대 parentCard 밖으로 나가지 않음!)
        const scanTargets = [vid, vid.parentElement, vid.parentElement?.parentElement].filter(Boolean);
        for (const targetEl of scanTargets) {
            if (parentCard && !parentCard.contains(targetEl)) continue;
            let vFiber = getFiberFromEl(targetEl);
            let vDepth = 0;

            while (vFiber && vDepth < 35) {
                // ★ 포스트 카드 경계 이탈 방지: host DOM 노드가 parentCard 밖이면 즉시 중단!
                if (parentCard && vFiber.stateNode instanceof Element && !parentCard.contains(vFiber.stateNode) && vFiber.stateNode !== parentCard) {
                    break;
                }

                const pList = [vFiber.memoizedProps, vFiber.pendingProps, vFiber.stateNode && vFiber.stateNode.props].filter(Boolean);
                let hitOtherPost = false;

                for (const p of pList) {
                    // 만약 상위 피드 리스트(thread_items 등)나 다른 게시글 코드에 도달하면 즉시 탐색 중단
                    const pCode = (typeof p.code === 'string' && p.code.length > 3) ? p.code : (p.post?.code || p.item?.code || p.media?.code || null);
                    if (pCode && foundCode && pCode !== foundCode) {
                        hitOtherPost = true;
                        break;
                    }
                    if (!foundCode && pCode) {
                        foundCode = pCode;
                    }

                    if (!foundUrl) {
                        const u = extractVideoUrl(p);
                        if (u && !isAudioUrl(u)) {
                            foundUrl = u;
                        }
                    }
                    if (!foundThumb) {
                        // ★ 주의: 상위 포스트(p.post)나 캐러셀 루트 객체에서 image_versions2를 가져오면
                        // [이미지 1개 + 영상 1개] 캐러셀의 1번 이미지가 영상의 썸네일(foundThumb)로 둔갑하여
                        // 1번 이미지가 삭제되거나 2번째 영상으로 치환되는 치명적 버그가 발생함!
                        // 반드시 현재 비디오 슬라이드 자신의 미디어 객체에서만 썸네일을 추출할 것!
                        const isCarouselContainer = !!(p.carousel_media || p.carouselMedia || p.carousel_items || p.media_type === 8 || p.post);
                        if (!isCarouselContainer && isMediaObjectKnownVideo(p)) {
                            const imgU = extractBestImageUrl(p);
                            if (imgU) foundThumb = imgU;
                        }
                    }
                }

                if (hitOtherPost) break;

                // Hook memoizedState 탐색
                if (!foundUrl && vFiber.memoizedState) {
                    let hook = vFiber.memoizedState;
                    let hDepth = 0;
                    while (hook && hDepth < 25) {
                        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
                            const u = extractVideoUrl(hook.memoizedState);
                            if (u && !isAudioUrl(u)) {
                                foundUrl = u;
                                break;
                            }
                        }
                        hook = hook.next;
                        hDepth++;
                    }
                }

                if (foundUrl && foundCode) break;
                if (parentCard && vFiber.stateNode === parentCard) break;
                vFiber = vFiber.return;
                vDepth++;
            }
            if (foundUrl) break;
        }

        if (foundUrl) {
            vid.setAttribute('data-dreaths-video-url', foundUrl);
            if (foundThumb) vid.setAttribute('data-dreaths-thumb-url', foundThumb);
            if (foundCode) vid.setAttribute('data-dreaths-post-code', foundCode);
        }

        return { videoUrl: foundUrl, thumbUrl: foundThumb, postCode: foundCode };
    };

    // 특정 포스트 컨테이너 내부의 전체 미디어(캐러셀 슬라이드 + 비디오 + 포스트 메타) 정밀 스캔
    // Relay Data Masking 대응: 컨테이너 자신뿐만 아니라 내부 미디어/캐러셀 자식 요소들의 Fiber까지 역추적
    const scanPostContainerFibers = (containerEl, results) => {
        if (!containerEl || !containerEl.querySelectorAll) return null;

        const nestedQuotes = Array.from(containerEl.querySelectorAll('[data-pressable-container="true"]')).filter(q => q !== containerEl);
        const isInsideQuote = (node) => nestedQuotes.some(q => q.contains(node));

        const domMeta = extractStrictDomPostMeta(containerEl);
        let targetCode = domMeta.code;
        let targetAuthor = domMeta.author;
        let bestMediaItems = [];

        // 컨테이너 내부의 미디어 요소들(img, video)과 컨테이너 자신으로부터 Fiber 경로 수집
        const mediaDomNodes = Array.from(containerEl.querySelectorAll('video, img, ul, [role="list"], [role="listitem"]'))
            .filter(n => !isInsideQuote(n));
        const seedElements = [containerEl, ...mediaDomNodes];
        const visitedFibers = new WeakSet();
        const visitedObjs = new WeakSet();

        const inspectCandidatePostObj = (postObj) => {
            if (!postObj || typeof postObj !== 'object' || visitedObjs.has(postObj)) return;
            visitedObjs.add(postObj);

            const code = postObj.code || postObj.shortcode;
            // 만약 DOM에서 확인된 고유 게시글 코드(targetCode)가 있는데 다른 코드의 객체라면 무시 (인용글/인접글 혼입 차단!)
            if (targetCode && code && code !== targetCode) return;
            if (!targetCode && code && typeof code === 'string' && code.length > 3) {
                targetCode = code;
            }

            const effectiveCode = code || targetCode;
            const mItems = extractMediaFromPost(postObj);
            if (mItems.length > 0) {
                if (calcMediaQualityScore(mItems) > calcMediaQualityScore(bestMediaItems)) {
                    bestMediaItems = mItems;
                }
                if (effectiveCode) {
                    mergeMediaIntoCache(effectiveCode, mItems, results?.media);
                }
            }

            if (effectiveCode && results) {
                const pd = results.posts[effectiveCode] || {};
                for (const vk of ['view_count', 'play_count', 'video_view_count', 'ig_play_count', 'impression_count', 'reach_count']) {
                    if (postObj[vk] !== undefined && parseInt(postObj[vk]) > 0) {
                        pd.views = parseInt(postObj[vk]);
                        results.views[effectiveCode] = pd.views;
                        break;
                    }
                }
                const tpai = postObj.text_post_app_info;
                if (tpai) {
                    for (const vk of ['view_count', 'play_count', 'impression_count']) {
                        if (tpai[vk] !== undefined && parseInt(tpai[vk]) > 0) {
                            pd.views = parseInt(tpai[vk]);
                            results.views[effectiveCode] = pd.views;
                            break;
                        }
                    }
                    if (tpai.direct_reply_count !== undefined) pd.replies = parseInt(tpai.direct_reply_count);
                    if (tpai.share_info) {
                        if (tpai.share_info.repost_count !== undefined) pd.reposts = parseInt(tpai.share_info.repost_count);
                        if (tpai.share_info.share_count !== undefined) pd.shares = parseInt(tpai.share_info.share_count);
                    }
                }
                if (postObj.like_count !== undefined) pd.likes = parseInt(postObj.like_count);
                if (postObj.comment_count !== undefined) pd.replies = parseInt(postObj.comment_count);
                if (postObj.taken_at !== undefined) pd.taken_at = parseInt(postObj.taken_at);

                if (postObj.user && postObj.user.username) {
                    pd.author = postObj.user.username;
                    if (!targetAuthor) targetAuthor = postObj.user.username.toLowerCase();
                    if (postObj.user.follower_count !== undefined) {
                        results.followers[postObj.user.username] = parseInt(postObj.user.follower_count);
                    }
                }
                if (Object.keys(pd).length > 0) {
                    results.posts[effectiveCode] = pd;
                }
            }
        };

        // 객체 내 post/carousel/media 구조 탐색 (최대 깊이 4)
        const scanPropsDeep = (obj, depth = 0) => {
            if (!obj || typeof obj !== 'object' || depth > 4 || visitedObjs.has(obj)) return;
            visitedObjs.add(obj);

            if (Array.isArray(obj)) {
                for (let i = 0; i < obj.length; i++) {
                    if (obj[i] && typeof obj[i] === 'object') {
                        scanPropsDeep(obj[i], depth + 1);
                    }
                }
                return;
            }

            // quoted_post / reposted_post 내부는 절대 스캔하지 않음
            if ((obj.code && typeof obj.code === 'string' && obj.code.length > 3) ||
                obj.carousel_media || obj.carouselMedia || obj.carousel_items || obj.carouselItems ||
                obj.edge_sidecar_to_children || obj.sidecar_children ||
                obj.video_versions || obj.videoVersions) {
                inspectCandidatePostObj(obj);
            }

            for (const key of Object.keys(obj)) {
                if (key === 'quoted_post' || key === 'reposted_post' || key === 'share_info' || key === 'parent_post' ||
                    key === 'video_versions' || key === 'videoVersions' || key === 'progressive_urls' || key === 'progressiveUrls' || key === 'candidates') {
                    continue;
                }
                const val = obj[key];
                if (val && typeof val === 'object') {
                    scanPropsDeep(val, depth + 1);
                }
            }
        };

        for (const seedEl of seedElements) {
            let fiber = getFiberFromEl(seedEl);
            let steps = 0;
            const maxSteps = seedEl === containerEl ? 25 : 35;

            while (fiber && steps < maxSteps) {
                if (visitedFibers.has(fiber)) break;
                visitedFibers.add(fiber);

                // 컨테이너 바깥의 상위 DOM 노드로 이탈하면 즉시 중단!
                if (fiber.stateNode instanceof Element && !containerEl.contains(fiber.stateNode) && fiber.stateNode !== containerEl) {
                    break;
                }

                const propsToCheck = [
                    fiber.memoizedProps,
                    fiber.pendingProps,
                    fiber.stateNode && fiber.stateNode.props,
                ].filter(Boolean);

                for (const props of propsToCheck) {
                    scanPropsDeep(props, 0);
                }

                // Hook memoizedState 내 캐러셀/비디오 데이터 탐색
                if (fiber.memoizedState) {
                    let hook = fiber.memoizedState;
                    let hStep = 0;
                    while (hook && hStep < 20) {
                        if (hook.memoizedState && typeof hook.memoizedState === 'object') {
                            scanPropsDeep(hook.memoizedState, 1);
                        }
                        hook = hook.next;
                        hStep++;
                    }
                }

                fiber = fiber.return;
                steps++;
            }
        }

        // 컨테이너 내부의 <video> 요소들 각각에 대해 직접 비디오 URL 추출 및 병합
        const innerVideos = Array.from(containerEl.querySelectorAll('video')).filter(v => !isInsideQuote(v));
        if (innerVideos.length > 0) {
            const extractedVideos = [];
            const seenVidUrls = new Set();
            innerVideos.forEach(vid => {
                const { videoUrl, thumbUrl, postCode: vCode } = extractVideoUrlForVideoElement(vid, containerEl, targetCode);
                if (!targetCode && vCode) targetCode = vCode;
                if (videoUrl && !seenVidUrls.has(videoUrl)) {
                    seenVidUrls.add(videoUrl);
                    extractedVideos.push({ type: 'video', url: videoUrl, thumbnail_url: thumbUrl || videoUrl });
                }
            });

            if (extractedVideos.length > 0) {
                if (bestMediaItems.length > 1) {
                    // 캐러셀인 경우: 비디오 슬롯(type === 'video')의 URL만 보강하고 이미지 슬롯(type === 'image')은 절대 건드리지 않음!
                    let vIdx = 0;
                    bestMediaItems = bestMediaItems.map(item => {
                        if (item.type === 'video' && extractedVideos[vIdx]) {
                            const shouldUpgrade = !item.url || isAudioUrl(item.url) ||
                                                  (!isProgressiveVideoUrl(item.url) && isProgressiveVideoUrl(extractedVideos[vIdx].url));
                            const chosen = extractedVideos[vIdx++];
                            if (shouldUpgrade) {
                                return {
                                    type: 'video',
                                    url: chosen.url,
                                    thumbnail_url: (item.thumbnail_url && item.thumbnail_url !== item.url) ? item.thumbnail_url : chosen.thumbnail_url
                                };
                            }
                        }
                        return item;
                    }).filter(item => item && item.url);
                } else if (bestMediaItems.length === 0 || (bestMediaItems.length === 1 && bestMediaItems[0].type === 'video')) {
                    bestMediaItems = extractedVideos;
                } else if (bestMediaItems.length === 1 && bestMediaItems[0].type === 'image') {
                    // bestMediaItems에 이미지 1개만 있는 경우: 해당 이미지가 비디오 커버인지 별도 슬라이드 이미지인지 판별
                    const imgBase = (bestMediaItems[0].url || '').split('?')[0];
                    const isCoverOfExtracted = extractedVideos.some(v =>
                        (v.thumbnail_url && v.thumbnail_url.split('?')[0] === imgBase) ||
                        bestMediaItems[0].url.includes('video_default_cover_frame')
                    );
                    if (isCoverOfExtracted) {
                        bestMediaItems = extractedVideos;
                    } else {
                        bestMediaItems = [bestMediaItems[0], ...extractedVideos];
                    }
                }
                if (targetCode) {
                    mergeMediaIntoCache(targetCode, bestMediaItems, results?.media);
                }
            }
        }

        bestMediaItems = bestMediaItems.filter(item => item && item.url);

        if (targetCode && bestMediaItems.length === 0 && window.__DREATHE_MEDIA_CACHE__[targetCode]) {
            bestMediaItems = window.__DREATHE_MEDIA_CACHE__[targetCode];
        }

        return {
            code: targetCode,
            author: targetAuthor,
            mediaItems: bestMediaItems
        };
    };

    // ===== ★ React Fiber 스캐너 (MAIN world에서 실행) =====
    const scanReactFibers = () => {
        try {
            const results = { posts: {}, followers: {}, views: {}, media: {} };

            // 1. 개별 포스트 컨테이너 정밀 스캔 (하위 인용글이 아닌 독립 포스트 카드만)
            const containers = document.querySelectorAll('div[data-pressable-container="true"], article, div[role="article"]');
            containers.forEach(el => {
                scanPostContainerFibers(el, results);
            });

            // 2. 만약 pressable container 밖에 위치한 <video>가 있는 경우(상세 페이지 상단 메인 포스트 등)에만 개별 스캔
            const videoEls = document.querySelectorAll('video');
            videoEls.forEach(vid => {
                const parentCard = vid.closest('div[data-pressable-container="true"], article, div[role="article"]');
                if (parentCard) return; // 이미 1단계 scanPostContainerFibers에서 캐러셀/컨테이너 단위로 정밀 스캔됨
                let targetCode = null;
                const pathM = window.location.pathname.match(/\/(?:post|t)\/([^\/\?#]+)/);
                if (pathM) targetCode = pathM[1];
                const { videoUrl, thumbUrl, postCode } = extractVideoUrlForVideoElement(vid, null, targetCode);
                const finalCode = targetCode || postCode;
                if (videoUrl && finalCode) {
                    const vItem = [{ type: 'video', url: videoUrl, thumbnail_url: thumbUrl || videoUrl }];
                    mergeMediaIntoCache(finalCode, vItem, results.media);
                }
            });

            if (Object.keys(results.posts).length > 0 || Object.keys(results.views).length > 0 || Object.keys(results.followers).length > 0 || Object.keys(results.media).length > 0) {
                sendData('DREATHS_FIBER_DATA', results);
            }
        } catch(e) {
            console.error('[DReaThs Fiber] Error:', e);
        }
    };

    // 초기 즉각 스캔 (50ms, 200ms, 600ms, 1200ms)
    setTimeout(scanReactFibers, 50);
    setTimeout(scanReactFibers, 200);
    setTimeout(scanReactFibers, 600);
    setTimeout(scanReactFibers, 1200);
    setInterval(scanReactFibers, 1000);

    // 스크롤 시 React Fiber 즉각 스캔 (디바운스 150ms)
    let fiberScrollTimer = null;
    window.addEventListener('scroll', () => {
        if (fiberScrollTimer) return;
        fiberScrollTimer = setTimeout(() => {
            fiberScrollTimer = null;
            scanReactFibers();
        }, 150);
    }, { passive: true });

    // 외부(content.js)로부터의 즉각 스캔 및 타겟 컨테이너 미디어 직접 추출 요청 처리
    window.addEventListener('message', (e) => {
        if (e.source !== window || !e.data) return;
        if (e.data.type === 'DREATHS_REQUEST_FIBER_SCAN') {
            scanReactFibers();
        } else if (e.data.type === 'DREATHS_EXTRACT_CONTAINER_MEDIA' || e.data.type === 'DREATHS_EXTRACT_TARGET_VIDEO') {
            try {
                const requestedCode = e.data.postCode || null;
                const results = { posts: {}, followers: {}, views: {}, media: {} };

                // 1순위: content.js가 지정한 정확한 스크랩 대상 DOM 컨테이너('[data-dreaths-scrap-target="true"]') 스캔
                const markedTarget = document.querySelector('[data-dreaths-scrap-target="true"]');
                let extracted = null;
                if (markedTarget) {
                    extracted = scanPostContainerFibers(markedTarget, results);
                    if (extracted) {
                        const finalCode = extracted.code || requestedCode;
                        if (finalCode && extracted.mediaItems && extracted.mediaItems.length > 0) {
                            mergeMediaIntoCache(finalCode, extracted.mediaItems, results.media);
                        }
                        const finalMedia = (finalCode && window.__DREATHE_MEDIA_CACHE__[finalCode]) || extracted.mediaItems || [];
                        const payloadAttr = {
                            code: finalCode || null,
                            postCode: finalCode || null,
                            author: extracted.author || null,
                            media: finalMedia,
                            mediaItems: finalMedia
                        };
                        markedTarget.setAttribute('data-dreaths-extracted-media', JSON.stringify(payloadAttr));
                    }
                }

                // 2순위: requestedCode와 정확히 일치하는 포스트 컨테이너 내 비디오 스캔 (절대 다른 포스트의 비디오는 건드리지 않음!)
                if (requestedCode) {
                    const allVids = document.querySelectorAll('video');
                    for (const vid of allVids) {
                        const parentCard = vid.closest('[data-dreaths-scrap-target="true"], div[data-pressable-container="true"], article, div[role="article"]');
                        let matchesPost = false;
                        if (markedTarget && markedTarget.contains(vid)) {
                            matchesPost = true;
                        } else if (parentCard) {
                            const { code: cardCode } = extractStrictDomPostMeta(parentCard);
                            if (cardCode === requestedCode) matchesPost = true;
                        }
                        if (!matchesPost) continue;

                        const { videoUrl, thumbUrl } = extractVideoUrlForVideoElement(vid, parentCard, requestedCode);
                        if (videoUrl) {
                            const vItems = [{ type: 'video', url: videoUrl, thumbnail_url: thumbUrl || videoUrl }];
                            mergeMediaIntoCache(requestedCode, vItems, results.media);
                            sendData('DREATHS_TARGET_VIDEO_RESULT', { postCode: requestedCode, videoUrl, thumbnailUrl: thumbUrl });
                        }
                    }
                }

                if (Object.keys(results.media).length > 0) {
                    sendData('DREATHS_MEDIA_DATA', { media: results.media });
                }
                if (Object.keys(results.posts).length > 0 || Object.keys(results.views).length > 0 || Object.keys(results.followers).length > 0) {
                    sendData('DREATHS_FIBER_DATA', results);
                }
            } catch(err) {}
        }
    });

    console.log('[DReaThs] API Interceptor + Subtree Fiber Scanner v1.60 loaded');
})();



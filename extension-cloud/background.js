// background.js - Listens for scrap requests and sends directly to DreaThs Main Server

const MAIN_SERVER_BASE_URL = 'https://hongthreads.hongsik.blog/api';
const FALLBACK_API_BASE_URL = 'https://hongthreads.hongsik.blog/api';

function cleanJwtToken(raw) {
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

/**
 * Retrieves the stored JWT token with Google Account sync priority + local fallback & auto-migration
 */
async function getStoredJwt() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['dreaths_jwt'], (localResult) => {
            const localToken = cleanJwtToken(localResult?.dreaths_jwt);
            if (localToken) {
                resolve(localToken);
            } else {
                chrome.storage.local.get(['dreaths_jwt'], (syncResult) => {
                    const syncToken = cleanJwtToken(syncResult?.dreaths_jwt);
                    if (syncToken) {
                        chrome.storage.local.set({ dreaths_jwt: syncToken });
                        resolve(syncToken);
                    } else {
                        resolve(null);
                    }
                });
            }
        });
    });
}

function isAudioUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    if (lower.includes('_audio_dashinit') || 
        lower.includes('audio_dashinit') ||
        lower.includes('dash_ln_heaac') ||
        lower.includes('dash_heaac') ||
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
            if ((tag.includes('audio') || tag.includes('heaac')) &&
                !tag.includes('progressive') &&
                !tag.includes('vp9') &&
                !tag.includes('av1') &&
                !tag.includes('h264') &&
                !tag.includes('baseline') &&
                !tag.includes('main')) {
                return true;
            }
        }
    } catch(e) {}
    return false;
}

function cleanVideoUrl(url) {
    if (!url || typeof url !== 'string') return url;
    return url
        .replace(/([?&])bytestart=\d+(&|$)/g, '$1')
        .replace(/([?&])byteend=\d+(&|$)/g, '$1')
        .replace(/[?&]+$/, '')
        .replace(/\?&+/g, '?')
        .replace(/&&+/g, '&');
}

/**
 * 수집하지 못한 영상 URL 을 서버로 보내 Slack drt_error 채널에 리포트한다.
 * 리포트 실패가 사용자 안내를 막지 않도록 모든 예외를 삼킨다.
 */
async function reportScrapVideoFailure(token, payload, issues) {
    const body = JSON.stringify({
        postUrl: payload && payload.original_url,
        author: payload && payload.original_author,
        extensionVersion: chrome.runtime.getManifest().version,
        userAgent: navigator.userAgent,
        issues: (issues || []).slice(0, 10)
    });
    const safeToken = cleanJwtToken(token);
    for (const base of [MAIN_SERVER_BASE_URL, FALLBACK_API_BASE_URL]) {
        try {
            const res = await fetch(`${base}/errors/scrap-media`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${safeToken}`
                },
                body,
                signal: AbortSignal.timeout(4000)
            });
            if (res.ok) return true;
        } catch (e) {
            console.warn('[Scrap Video Report] failed via', base, e && e.message);
        }
    }
    return false;
}

/**
 * Uploads a base64 or blob media directly to S3 via Presigned URL
 */
async function uploadMediaViaPresignedUrl(mediaItem, token, issues) {
    if (!mediaItem) return mediaItem;
    const safeToken = cleanJwtToken(token);

    // 영상 수집 실패는 조용히 넘기지 않고 issues 에 기록 → 스크랩 중단 + drt_error 리포트 + 사용자 안내
    const wasVideo = mediaItem.type === 'video';
    let flagged = false;
    const flag = (stage, reason) => {
        if (wasVideo && !flagged && Array.isArray(issues)) {
            flagged = true;
            issues.push({ stage, url: mediaItem.url || '', reason: reason || '' });
        }
    };

    let updatedItem = { ...mediaItem };
    if (updatedItem.type === 'video' && updatedItem.url) {
        updatedItem.url = cleanVideoUrl(updatedItem.url);
    }

    // 오디오 스트림(검은 화면) 방지
    if (updatedItem.type === 'video' && isAudioUrl(updatedItem.url)) {
        console.warn('[Direct S3 Upload] Blocked audio-only stream disguised as video:', updatedItem.url);
        flag('AUDIO_ONLY_STREAM', '오디오 전용 스트림 주소만 수집됨');
        if (updatedItem.thumbnail_url && !isAudioUrl(updatedItem.thumbnail_url)) {
            updatedItem.type = 'image';
            updatedItem.url = updatedItem.thumbnail_url;
        }
    }

    const uploadViaFallbackApi = async (blob, filename) => {
        const tryEndpoint = async (baseUrl) => {
            const formData = new FormData();
            formData.append('file', blob, filename);
            const res = await fetch(`${baseUrl}/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${safeToken}`
                },
                body: formData
            });
            if (!res.ok) return null;
            return await res.json();
        };
        try {
            const d1 = await tryEndpoint(MAIN_SERVER_BASE_URL).catch(() => null);
            if (d1 && d1.url) return d1;
            const d2 = await tryEndpoint(FALLBACK_API_BASE_URL).catch(() => null);
            if (d2 && d2.url) return d2;
        } catch (e) {}
        return null;
    };

    // 0. thumbnail_base64가 있는 경우 썸네일 먼저 S3에 업로드
    if (updatedItem.thumbnail_base64 && (!updatedItem.thumbnail_url || (!updatedItem.thumbnail_url.includes('.amazonaws.com') && !updatedItem.thumbnail_url.includes('cdn.agczero.com')))) {
        try {
            const thumbBlob = await (await fetch(updatedItem.thumbnail_base64)).blob();
            let thumbUploaded = false;

            let preRes = await fetch(`${MAIN_SERVER_BASE_URL}/upload/presigned-url`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${safeToken}`
                },
                body: JSON.stringify({ fileType: 'image/jpeg', ext: 'jpg', prefix: 'uploads/drt_thumb' })
            }).catch(() => null);

            if (!preRes || !preRes.ok) {
                preRes = await fetch(`${FALLBACK_API_BASE_URL}/upload/presigned-url`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${safeToken}`
                    },
                    body: JSON.stringify({ fileType: 'image/jpeg', ext: 'jpg', prefix: 'uploads/drt_thumb' })
                }).catch(() => null);
            }

            if (preRes && preRes.ok) {
                try {
                    const preData = await preRes.json();
                    const putRes = await fetch(preData.uploadUrl, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'image/jpeg' },
                        body: thumbBlob
                    });
                    if (putRes.ok) {
                        updatedItem.thumbnail_url = preData.finalPublicUrl;
                        thumbUploaded = true;
                    }
                } catch (putErr) {
                    console.warn('[Direct S3 Upload] Thumbnail presigned PUT failed, falling back to /api/upload:', putErr);
                }
            }

            if (!thumbUploaded) {
                const fbThumb = await uploadViaFallbackApi(thumbBlob, 'thumbnail.jpg');
                if (fbThumb && fbThumb.url) {
                    updatedItem.thumbnail_url = fbThumb.url;
                }
            }
        } catch (tErr) {
            console.warn('[Direct S3 Upload] Thumbnail S3 upload failed:', tErr);
        }
    }

    if (!updatedItem.url) return updatedItem;
    // Already an S3 URL
    if (updatedItem.url.includes('.amazonaws.com') || updatedItem.url.includes('cdn.agczero.com')) return updatedItem;

    // Blob URL은 백그라운드 Service Worker에서 fetch 불가하므로 원본 보존
    if (updatedItem.url.startsWith('blob:')) {
        console.warn('[Direct S3 Upload] Blob URL cannot be fetched in background, keeping as-is');
        flag('BLOB_URL_UNFETCHABLE', 'blob: 주소는 백그라운드에서 다운로드할 수 없음');
        return updatedItem;
    }

    try {
        // 1. Fetch binary buffer in browser first
        let bodyToUpload;
        if (updatedItem.url.startsWith('data:')) {
            const res = await fetch(updatedItem.url);
            bodyToUpload = await res.blob();
        } else {
            const res = await fetch(updatedItem.url);
            if (!res.ok) {
                flag('DOWNLOAD_FAILED', `HTTP ${res.status}`);
                throw new Error(`Media fetch failed: ${res.status}`);
            }
            bodyToUpload = await res.blob();
        }

        let isVideo = updatedItem.type === 'video';
        // ★ 비디오 검증: 비디오 타입으로 넘어왔으나 실제 바이너리가 영상이 아닌 경우(이미지/오류 페이지/빈 파일) 기록하고
        //   JPEG 이미지는 image 타입으로 교정한다. (영상 수집 실패로 집계되어 스크랩 중단 + drt_error 리포트)
        if (isVideo && bodyToUpload) {
            try {
                const headBuf = await bodyToUpload.slice(0, 16).arrayBuffer();
                const bytes = new Uint8Array(headBuf);
                const headText = String.fromCharCode(...bytes).toLowerCase();
                const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
                const isPng = bytes[0] === 0x89 && headText.slice(1, 4) === 'png';
                const isGif = headText.startsWith('gif');
                const isWebpImg = headText.startsWith('riff') && headText.slice(8, 12) === 'webp';
                const isHtml = headText.trim().startsWith('<') || headText.trim().startsWith('{');
                if (bodyToUpload.size < 1024 && !isJpeg) {
                    flag('NOT_A_VIDEO_FILE', `파일 용량이 너무 작음 (${bodyToUpload.size} bytes)`);
                } else if (isJpeg || isPng || isGif || isWebpImg || isHtml) {
                    flag('NOT_A_VIDEO_FILE', isHtml ? '영상 주소가 웹 문서/오류 응답을 반환함' : '영상 주소가 실제로는 이미지 파일임');
                }
                if (isJpeg) {
                    console.warn('[Direct S3 Upload] Detected JPEG image bytes in video item. Correcting type to image/jpeg.');
                    isVideo = false;
                    updatedItem.type = 'image';
                }
            } catch (hErr) {}
        }

        const fileType = isVideo ? 'video/mp4' : 'image/jpeg';
        const ext = isVideo ? 'mp4' : 'jpg';

        // 2. Get Presigned URL from Main Server (Fallback to domain)
        let preRes = await fetch(`${MAIN_SERVER_BASE_URL}/upload/presigned-url`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ fileType, ext, prefix: 'uploads/drt_scrap' })
        }).catch(() => null);

        if (!preRes || !preRes.ok) {
            preRes = await fetch(`${FALLBACK_API_BASE_URL}/upload/presigned-url`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ fileType, ext, prefix: 'uploads/drt_scrap' })
            }).catch(() => null);
        }

        if (preRes && preRes.ok) {
            try {
                const preData = await preRes.json();
                const uploadUrl = preData.uploadUrl;
                const finalPublicUrl = preData.finalPublicUrl;

                // 3. Directly PUT to S3/R2 (0% Server Traffic!)
                const putRes = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': fileType
                    },
                    body: bodyToUpload
                });

                if (putRes.ok) {
                    return {
                        ...updatedItem,
                        type: updatedItem.type,
                        url: finalPublicUrl
                    };
                }
                console.warn('[Direct S3 Upload] S3 PUT returned non-OK:', putRes.status);
            } catch (putErr) {
                console.warn('[Direct S3 Upload] S3 PUT threw error, falling back to /api/upload:', putErr);
            }
        }

        // 4. Fallback to Main Server /api/upload if Presigned PUT failed (e.g. CORS or network)
        const fbData = await uploadViaFallbackApi(bodyToUpload, `scrap.${ext}`);
        if (fbData && fbData.url) {
            return {
                ...updatedItem,
                type: updatedItem.type,
                url: fbData.url,
                thumbnail_url: updatedItem.thumbnail_url || fbData.thumbnail_url || fbData.url
            };
        }

        console.warn('[Direct S3 Upload] Both Presigned PUT and /api/upload fallback failed');
        flag('S3_UPLOAD_FAILED', '스토리지 업로드 실패');
        return updatedItem;
    } catch (err) {
        console.warn('[Direct S3 Upload] Error uploading directly to S3:', err);
        flag('DOWNLOAD_FAILED', String(err && err.message ? err.message : err));
        return updatedItem;
    }
}

chrome.runtime.onMessage.addListener((message, sender, originalSendResponse) => {
    const sendResponse = result => { if (self.__DREATHS_LOCAL_RESULT) self.__DREATHS_LOCAL_RESULT(message, sender, result); originalSendResponse(result); };
    if (message.action === "OPEN_TAB" && self.__DREATHS_LOCAL_HAS_JOB?.(sender.tab?.id)) { sendResponse({success:true}); return false; }
    if (message.action === 'OPEN_TAB') {
        chrome.tabs.create({ url: message.url || 'https://hongthreads.hongsik.blog/dashboard/benchmark' });
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'SCRAP_THREAD') {
        (async () => {
            const token = await getStoredJwt();

            if (!token) {
                sendResponse({ 
                    success: false, 
                    error: 'JWT 토큰이 익스텐션에 설정되지 않았습니다. [확인]을 누르면 연동 키 발급 페이지로 이동합니다.',
                    needToken: true
                });
                return;
            }

            const payload = message.payload || {};

            // content.js 가 DOM 단계에서 수집하지 못한 영상 정보 + 업로드 단계에서 발생하는 영상 실패를 함께 모은다
            const videoIssues = Array.isArray(payload.video_issues) ? payload.video_issues.slice() : [];
            delete payload.video_issues;

            // 1. Try Direct S3 Upload for Media items
            if (Array.isArray(payload.media_items) && payload.media_items.length > 0) {
                try {
                    const uploadedMedia = await Promise.all(
                        payload.media_items.map(item => uploadMediaViaPresignedUrl(item, token, videoIssues))
                    );
                    payload.media_items = uploadedMedia;
                } catch (e) {
                    console.warn('[Direct S3 Upload] Batch upload warning:', e);
                }
            }

            // 1-1. 치명적 영상 수집 실패(원본 주소 미확보/오디오 전용/비정상 파일): 잘못된 스크랩이 저장되지 않도록 중단하고 drt_error 리포트
            // 단, 유효한 https 영상 주소가 있고 단순 브라우저 직접 업로드(S3_UPLOAD_FAILED / DOWNLOAD_FAILED)만 실패한 경우에는 메인 서버가 직접 다운로드·S3 업로드를 수행하므로 차단하지 않음
            const fatalVideoIssues = videoIssues.filter(i =>
                i.stage === 'DOM_VIDEO_URL_NOT_FOUND' ||
                i.stage === 'AUDIO_ONLY_STREAM' ||
                i.stage === 'BLOB_URL_UNFETCHABLE' ||
                i.stage === 'NOT_A_VIDEO_FILE'
            );
            if (fatalVideoIssues.length > 0) {
                await reportScrapVideoFailure(token, payload, videoIssues);
                sendResponse({
                    success: false,
                    code: 'VIDEO_SCRAP_FAILED',
                    error: '쓰레드에서 영상 벤치마킹에 실패했습니다. 잠시후 다시 시도하거나 관리자에게 문의주세요.'
                });
                return;
            }

            // 2. Send scrap metadata to Main Server first
            try {
                const mainRes = await fetch(`${MAIN_SERVER_BASE_URL}/reference/scrap`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(payload)
                });

                if (mainRes.ok) {
                    const data = await mainRes.json();
                    sendResponse({ 
                        success: true, 
                        data: data, 
                        today_count: data.today_count, 
                        max_limit: data.max_limit || 100 
                    });
                    return;
                } else {
                    const errData = await mainRes.json().catch(() => ({}));
                    if (mainRes.status === 429 || (errData && errData.error && errData.error.includes('한도'))) {
                        sendResponse({ 
                            success: false, 
                            error: errData.error || '하루 스크랩 수집 한도(100개)를 모두 소진했습니다. 내일 다시 시도해주세요.',
                            code: 'DAILY_LIMIT_EXCEEDED',
                            today_count: errData.today_count,
                            max_limit: errData.max_limit || 100
                        });
                        return;
                    }
                    console.warn(`[Extension Scrap] Main server IP returned status ${mainRes.status}. Falling back to main server domain...`);
                }
            } catch (mainErr) {
                console.warn('[Extension Scrap] Main server IP connection failed, falling back to main server domain:', mainErr);
            }

            // 3. Fallback to Main Server
            fetch(`${FALLBACK_API_BASE_URL}/reference/scrap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(payload)
            })
                .then(async res => {
                    const is401 = res.status === 401;
                    const is429 = res.status === 429;
                    const data = await res.json().catch(() => ({}));
                    return { data, is401, is429 };
                })
                .then(({ data, is401, is429 }) => {
                    if (is401) {
                        sendResponse({ 
                            success: false, 
                            error: '유효하지 않거나 만료된 JWT 토큰입니다. [확인]을 누르면 연동 키 발급 페이지로 이동합니다.',
                            needToken: true
                        });
                    } else if (is429 || (data && data.error && data.error.includes('한도'))) {
                        sendResponse({ 
                            success: false, 
                            error: data.error || '하루 스크랩 수집 한도(100개)를 모두 소진했습니다. 내일 다시 시도해주세요.',
                            code: 'DAILY_LIMIT_EXCEEDED',
                            today_count: data.today_count,
                            max_limit: data.max_limit || 100
                        });
                    } else if (data.error) {
                        const needToken = typeof data.error === 'string' && (data.error.includes('토큰') || data.error.includes('JWT') || data.error.includes('인증'));
                        sendResponse({ success: false, error: data.error, needToken });
                    } else {
                        sendResponse({ 
                            success: true, 
                            data: data, 
                            today_count: data.today_count, 
                            max_limit: data.max_limit || 100 
                        });
                    }
                })
                .catch(err => {
                    sendResponse({ success: false, error: err.toString() });
                });
        })();

        return true;
    }

    if (message.action === 'GET_FOLDERS') {
        (async () => {
            const token = await getStoredJwt();
            if (!token) {
                sendResponse({ success: false, folders: [], needToken: true });
                return;
            }

            const candidateUrls = [
                `${MAIN_SERVER_BASE_URL}/scraps/folders`,
                `${FALLBACK_API_BASE_URL}/scraps/folders`,
                'https://hongthreads.hongsik.blog/api/scraps/folders',
                'https://hongthreads.hongsik.blog/api/scraps/folders'
            ];

            for (const url of candidateUrls) {
                try {
                    const res = await fetch(url, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && Array.isArray(data.folders)) {
                            sendResponse({ 
                                success: true, 
                                folders: data.folders,
                                today_count: data.today_count,
                                daily_limit: data.daily_limit || 100
                            });
                            return;
                        }
                    } else if (res.status === 401) {
                        console.warn('[Extension Folders] 401 Unauthorized for URL:', url);
                    }
                } catch (err) {
                    // Try next candidate
                }
            }

            sendResponse({ success: false, folders: [] });
        })();
        return true;
    }

    if (message.action === 'GET_DAILY_STATUS') {
        (async () => {
            const token = await getStoredJwt();
            if (!token) {
                sendResponse({ success: false, needToken: true });
                return;
            }

            const candidateUrls = [
                `${MAIN_SERVER_BASE_URL}/scraps/folders`,
                `${FALLBACK_API_BASE_URL}/scraps/folders`,
                'https://hongthreads.hongsik.blog/api/scraps/folders',
                'https://hongthreads.hongsik.blog/api/scraps/folders'
            ];

            for (const url of candidateUrls) {
                try {
                    const res = await fetch(url, {
                        headers: {
                            'Authorization': `Bearer ${token}`
                        }
                    });
                    if (res.ok) {
                        const data = await res.json();
                        sendResponse({ 
                            success: true, 
                            so_id: data.so_id || null,
                            today_count: data.today_count !== undefined ? data.today_count : 0,
                            daily_limit: data.daily_limit || 100
                        });
                        return;
                    }
                } catch (err) {}
            }

            sendResponse({ success: false });
        })();
        return true;
    }
});


importScripts("local-jobs.js");

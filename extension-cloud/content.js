// content.js - DReaThs Scraper v1.125
// content.js - Injected into threads.net / threads.com
window.DReaThsStats = window.DReaThsStats || { followers: {}, views: {}, media: {}, posts: {}, profiles: {} };

let dreathsShowEngagement = true;
let hasJwtKey = true;
const cleanJwtTokenStr = (raw) => {
    if (!raw || typeof raw !== 'string') return '';
    return raw.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
};
const checkJwtToken = (raw) => cleanJwtTokenStr(raw).length > 0;

// Settings initialization: merge sync and local safely (never overwrite a valid local token with empty sync token)
const initExtensionSettings = (fromStorageChange = false) => {
    try {
        chrome.storage.local.get(['dreaths_show_engagement', 'dreaths_jwt'], (localRes) => {
            chrome.storage.local.get(['dreaths_show_engagement', 'dreaths_jwt'], (syncRes) => {
                const localToken = cleanJwtTokenStr(localRes?.dreaths_jwt);
                const syncToken = cleanJwtTokenStr(syncRes?.dreaths_jwt);
                const mergedToken = localToken || syncToken;

                if (localRes?.dreaths_show_engagement !== undefined) {
                    dreathsShowEngagement = localRes.dreaths_show_engagement;
                } else if (syncRes?.dreaths_show_engagement !== undefined) {
                    dreathsShowEngagement = syncRes.dreaths_show_engagement;
                }

                hasJwtKey = mergedToken.length > 0;

                if (!fromStorageChange && mergedToken) {
                    if (!localToken) {
                        chrome.storage.local.set({ dreaths_jwt: mergedToken, dreaths_show_engagement: dreathsShowEngagement });
                    }
                    if (!syncToken) {
                        chrome.storage.local.set({ dreaths_jwt: mergedToken, dreaths_show_engagement: dreathsShowEngagement });
                    }
                }
                if (typeof injectAnalyticsUI === 'function') injectAnalyticsUI();
            });
        });
    } catch (e) {}
};
initExtensionSettings(false);

chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'sync' || namespace === 'local') {
        if (changes.dreaths_show_engagement) {
            dreathsShowEngagement = changes.dreaths_show_engagement.newValue;
            const overlayLayer = document.getElementById('dreaths-analytics-layer');
            if (overlayLayer) {
                overlayLayer.style.display = dreathsShowEngagement ? 'block' : 'none';
            }
        }
        if (changes.dreaths_jwt) {
            try {
                localStorage.removeItem('dreaths_cached_folders');
                localStorage.removeItem('dreaths_last_selected_folder');
            } catch (e) {}
            window.dreathsTodayCount = null;
            updateScrapButtonCountUI();
            initExtensionSettings(true);
            if (typeof window.dreathsReloadFolders === 'function') {
                window.dreathsReloadFolders();
            }
        }
    }
});

// ==========================================
// 1. 스크랩 플로팅 버튼 및 폴더 선택 드롭박스
// ==========================================
function ensureScrapContainerVisible(container) {
    if (!container) container = document.getElementById('dreaths-scrap-container');
    if (!container) return;
    if (container.dataset.isDragging === 'true') return;

    const rect = container.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;

    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    // 만약 버튼의 전체 또는 일부가 화면 밖으로 벗어났거나, 뷰포트 영역을 벗어난 경우
    const isOutOfViewport = (
        rect.left < 0 ||
        rect.top < 0 ||
        rect.right > vw ||
        rect.bottom > vh
    );

    if (isOutOfViewport) {
        // 현 화면의 우측 하단으로 즉시 위치 복귀
        container.style.left = 'auto';
        container.style.top = 'auto';
        container.style.right = '20px';
        container.style.bottom = '20px';
    }
}

// 창 크기 변경 시 화면 밖 이탈 방지
window.addEventListener('resize', () => {
    ensureScrapContainerVisible();
});

function updateScrapButtonCountUI() {
    const btn = document.getElementById('dreaths-scrap-btn');
    if (!btn || btn.dataset.inSelection === 'true') return;
    const iconUrl = chrome.runtime.getURL('logo_white.png');
    const limit = window.dreathsDailyLimit || 100;
    const count = window.dreathsTodayCount !== undefined ? window.dreathsTodayCount : null;

    if (count !== null && count >= limit) {
        btn.innerHTML = `<img src="${iconUrl}" alt="DReaThs" style="width:24px;height:24px;pointer-events:none;user-select:none;" draggable="false"><span style="pointer-events:none;user-select:none;font-size:13px;">한도초과 (${count}/${limit})</span>`;
        btn.style.backgroundColor = '#4b5563';
        btn.title = `오늘 수집 한도(${limit}개)를 모두 소진했습니다. 내일 다시 시도해주세요.`;
    } else if (count !== null) {
        btn.innerHTML = `<img src="${iconUrl}" alt="DReaThs" style="width:28px;height:28px;pointer-events:none;user-select:none;" draggable="false"><span style="pointer-events:none;user-select:none;">스크랩 (${count}/${limit})</span>`;
        btn.style.backgroundColor = '#000000';
        btn.title = `오늘 수집 현황: ${count} / ${limit}개`;
    } else {
        btn.innerHTML = `<img src="${iconUrl}" alt="DReaThs" style="width:28px;height:28px;pointer-events:none;user-select:none;" draggable="false"><span style="pointer-events:none;user-select:none;">스크랩</span>`;
        btn.style.backgroundColor = '#000000';
    }
}

function injectScrapButton() {
    const existing = document.getElementById('dreaths-scrap-container');
    if (existing) {
        ensureScrapContainerVisible(existing);
        updateScrapButtonCountUI();
        return;
    }

    const container = document.createElement('div');
    container.id = 'dreaths-scrap-container';
    container.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 100000;
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 6px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        user-select: none;
    `;

    // 상단 폴더 선택 드롭다운 (드랍박스)
    const select = document.createElement('select');
    select.id = 'dreaths-folder-dropdown';
    select.style.cssText = `
        background: #18181b;
        color: #f4f4f5;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 10px;
        padding: 7px 10px;
        font-size: 12px;
        font-weight: 800;
        outline: none;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        width: 100%;
        max-width: 170px;
        text-overflow: ellipsis;
        white-space: nowrap;
        overflow: hidden;
    `;

    // 마지막 선택 폴더 및 캐시된 폴더 복원
    const savedFolder = localStorage.getItem('dreaths_last_selected_folder');
    let cachedFolders = [];
    try {
        cachedFolders = JSON.parse(localStorage.getItem('dreaths_cached_folders') || '[]');
    } catch (e) {}

    const renderFolderOptions = (folders, needToken = false) => {
        let optionsHtml = `<option value="NONE">📁 미분류 (기본)</option>`;
        if (Array.isArray(folders) && folders.length > 0) {
            folders.forEach(f => {
                optionsHtml += `<option value="${f.id}">📁 ${f.folder_name}</option>`;
            });
        } else if (needToken) {
            optionsHtml += `<option value="NEED_KEY" disabled>⚠️ 연동 키(JWT) 필요 (확장 아이콘 클릭)</option>`;
        }

        if (select.innerHTML !== optionsHtml) {
            const currentVal = select.value || savedFolder || 'NONE';
            select.innerHTML = optionsHtml;
            if (currentVal && select.querySelector(`option[value="${currentVal}"]`)) {
                select.value = currentVal;
            }
        }
    };

    // 캐시된 폴더가 있으면 0ms 즉각 표시
    if (cachedFolders.length > 0) {
        renderFolderOptions(cachedFolders);
    } else {
        select.innerHTML = `<option value="NONE">📁 미분류 (기본)</option>`;
    }

    // 폴더 목록 원격 로드 함수
    let isLoadingFolders = false;
    const loadFolders = () => {
        if (isLoadingFolders) return;
        isLoadingFolders = true;
        try {
            chrome.runtime.sendMessage({ action: 'GET_FOLDERS' }, (res) => {
                isLoadingFolders = false;
                if (chrome.runtime.lastError) {
                    console.warn('[DReaThs] GET_FOLDERS error:', chrome.runtime.lastError.message);
                    return;
                }
                if (res && res.success && Array.isArray(res.folders)) {
                    if (res.today_count !== undefined) {
                        window.dreathsTodayCount = res.today_count;
                        window.dreathsDailyLimit = res.daily_limit || 100;
                        updateScrapButtonCountUI();
                    }
                    try {
                        localStorage.setItem('dreaths_cached_folders', JSON.stringify(res.folders));
                    } catch (e) {}
                    renderFolderOptions(res.folders, false);
                } else if (res && res.needToken) {
                    renderFolderOptions([], true);
                }
            });
        } catch (e) {
            isLoadingFolders = false;
        }
    };

    select.addEventListener('focus', loadFolders);
    select.addEventListener('mouseenter', loadFolders);
    select.addEventListener('mousedown', loadFolders);
    select.addEventListener('change', (e) => {
        localStorage.setItem('dreaths_last_selected_folder', e.target.value);
    });

    window.dreathsReloadFolders = loadFolders;
    loadFolders();
    setTimeout(loadFolders, 1000);

    // 하단 스크랩 버튼
    const btn = document.createElement('button');
    btn.id = 'dreaths-scrap-btn';

    const iconUrl = chrome.runtime.getURL('logo_white.png');
    btn.innerHTML = `<img src="${iconUrl}" alt="DReaThs" style="width:28px;height:28px;pointer-events:none;user-select:none;" draggable="false"><span style="pointer-events:none;user-select:none;">스크랩</span>`;

    btn.style.cssText = `
        background-color: #000000;
        color: #ffffff;
        border: 1px solid rgba(255,255,255,0.1);
        border-radius: 12px;
        padding: 10px 16px;
        font-weight: 900;
        font-size: 16px;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        width: 100%;
        user-select: none;
        touch-action: none;
    `;

    // 드래그 기능
    let isDragging = false;
    let mouseDownTime = 0;
    let startX, startY, origLeft, origTop;

    container.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return; // 드롭다운 조작 시 드래그 방지
        mouseDownTime = Date.now();
        isDragging = false;
        startX = e.clientX;
        startY = e.clientY;
        const rect = container.getBoundingClientRect();
        origLeft = rect.left;
        origTop = rect.top;

        const onMouseMove = (e) => {
            isDragging = true;
            container.dataset.isDragging = 'true';

            const vw = window.innerWidth || document.documentElement.clientWidth;
            const vh = window.innerHeight || document.documentElement.clientHeight;
            const cWidth = container.offsetWidth || 170;
            const cHeight = container.offsetHeight || 90;

            let newLeft = origLeft + (e.clientX - startX);
            let newTop = origTop + (e.clientY - startY);

            // 화면 밖으로 완전히 벗어나지 않도록 clamp (최소 마진 10px 유지)
            const maxLeft = Math.max(10, vw - cWidth - 10);
            const maxTop = Math.max(10, vh - cHeight - 10);
            newLeft = Math.max(10, Math.min(newLeft, maxLeft));
            newTop = Math.max(10, Math.min(newTop, maxTop));

            container.style.right = 'auto';
            container.style.bottom = 'auto';
            container.style.left = newLeft + 'px';
            container.style.top = newTop + 'px';
        };

        const onMouseUp = () => {
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            container.dataset.isDragging = 'false';
            if (isDragging) {
                ensureScrapContainerVisible(container);
            }
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });

    // 더블클릭 시 우측 하단 기본 위치로 즉시 복귀
    container.addEventListener('dblclick', (e) => {
        if (e.target.tagName === 'SELECT' || e.target.tagName === 'OPTION') return;
        container.style.left = 'auto';
        container.style.top = 'auto';
        container.style.right = '20px';
        container.style.bottom = '20px';
    });

    btn.addEventListener('click', (e) => {
        const clickDuration = Date.now() - mouseDownTime;
        if (isDragging && clickDuration > 200) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        if (window.dreathsTodayCount !== undefined && window.dreathsTodayCount >= (window.dreathsDailyLimit || 100)) {
            alert(`하루 스크랩 수집 한도(${window.dreathsDailyLimit || 100}개)를 모두 소진했습니다. 내일 다시 시도해주세요.`);
            return;
        }
        handleScrapClick();
    });

    container.appendChild(select);
    container.appendChild(btn);
    updateScrapButtonCountUI();

    if (document.body) {
        document.body.appendChild(container);
    } else {
        document.documentElement.appendChild(container);
    }
}

// ==========================================
// 2. 스크랩 선택 모드 (전체 피드/검색/상세 뷰 완벽 감지)
// ==========================================
let isSelectionMode = false;

// 원본 게시글 탐색 함수 (피드/검색/프로필/상세 뷰 전 영역 완벽 지원)
function findOriginalPostContainer(target) {
    if (!target || target === document.body || target === document.documentElement) return null;
    if (target.closest('#dreaths-scrap-container')) return null;

    // 우측 사이드바 및 팔로우 추천 / 사용자 검색 결과 영역 스크랩 버튼 제외
    if (target.closest('[data-pagelet*="recommended_users"], [data-pagelet*="search_recommended_users"], [data-pagelet*="recommended_user"], aside')) {
        return null;
    }

    // 1단계: 마우스 커서가 위치한 가장 안쪽의 개별 포스트 컨테이너 우선 탐색
    let container = target.closest('[data-pressable-container="true"], article, div[role="article"]');

    // 만약 찾은 container가 article이고 내부에 여러 개의 data-pressable-container가 있다면
    // 커서를 포함하는 가장 안쪽 data-pressable-container를 선택 (상단 원글로 빨려들어가는 현상 차단)
    if (container) {
        const innerPressables = Array.from(container.querySelectorAll('[data-pressable-container="true"]'));
        let bestInner = null;
        for (const inner of innerPressables) {
            if (inner.contains(target)) {
                bestInner = inner;
            }
        }
        if (bestInner) {
            container = bestInner;
        }
    }

    // 2단계: 기본 셀렉터로 못 찾은 경우 (상세 뷰 상단 메인 글 등 data-pressable-container가 없는 영역)
    if (!container) {
        let el = target;
        while (el && el !== document.body && el !== document.documentElement) {
            // 만약 올라가다가 내부에 다른 pressable 컨테이너가 포함된 상위 래퍼를 만나면 중단
            const childPressables = el.querySelectorAll ? el.querySelectorAll('[data-pressable-container="true"]') : [];
            const nonQuotePressables = Array.from(childPressables).filter(p => !p.parentElement?.closest('[data-pressable-container="true"]'));
            if (nonQuotePressables.length > 1) {
                break;
            }

            const hasAuthor = el.querySelector('a[href*="/@"]');
            const hasActionOrTime = el.querySelector('time, svg, div[role="button"], a[href*="/post/"], a[href*="/t/"]');

            if (hasAuthor && hasActionOrTime) {
                const rect = el.getBoundingClientRect();
                if (rect.height > 50 && rect.width > 150) {
                    container = el;
                    break;
                }
            }
            el = el.parentElement;
        }
    }

    return container || null;
}

async function handleScrapClick() {
    if (isSelectionMode) return;
    isSelectionMode = true;

    const btn = document.getElementById('dreaths-scrap-btn');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.dataset.inSelection = 'true';
        btn.innerHTML = '<span>선택 취소 (ESC)</span>';
        btn.style.backgroundColor = '#d32f2f';
    }

    const mouseOverHandler = (e) => {
        if (e.target.closest('#dreaths-scrap-container')) return;

        const postContainer = findOriginalPostContainer(e.target);

        document.querySelectorAll('.drt-highlight').forEach(el => el.classList.remove('drt-highlight'));
        if (postContainer) {
            postContainer.classList.add('drt-highlight');
        }
    };

    const styleEl = document.createElement('style');
    styleEl.id = 'drt-highlight-style';
    styleEl.innerHTML = `
        .drt-highlight {
            outline: 3px solid #ff0050 !important;
            outline-offset: 2px !important;
            background-color: rgba(255, 0, 80, 0.05) !important;
            cursor: pointer !important;
            transition: outline 0.15s ease, background-color 0.15s ease !important;
        }
    `;
    document.head.appendChild(styleEl);

    const cleanup = () => {
        isSelectionMode = false;
        document.removeEventListener('mouseover', mouseOverHandler);
        document.removeEventListener('click', clickHandler, true);
        document.removeEventListener('keydown', keydownHandler);
        document.querySelectorAll('.drt-highlight').forEach(el => el.classList.remove('drt-highlight'));
        if (document.getElementById('drt-highlight-style')) {
            document.getElementById('drt-highlight-style').remove();
        }
        if (btn) {
            btn.dataset.inSelection = 'false';
            btn.innerHTML = originalText;
            btn.style.backgroundColor = '#000000';
            updateScrapButtonCountUI();
        }
    };

    const keydownHandler = (e) => {
        if (e.key === 'Escape') {
            cleanup();
        }
    };

    const clickHandler = (e) => {
        if (e.target.closest('#dreaths-scrap-container')) {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
            return;
        }

        let container = document.querySelector('.drt-highlight');
        if (!container) {
            container = findOriginalPostContainer(e.target);
        }
        if (!container) return;

        e.preventDefault();
        e.stopPropagation();

        cleanup();
        processContainer(container, { container });
    };

    document.addEventListener('mouseover', mouseOverHandler);
    document.addEventListener('click', clickHandler, true);
    document.addEventListener('keydown', keydownHandler);
}

// ==========================================
// 2.5 포스트 루트 및 메타데이터 엄격 탐색 헬퍼 (인접 게시글 혼선 완전 차단)
// ==========================================
function hasActionButtonInScope(scopeEl) {
    if (!scopeEl || !scopeEl.querySelectorAll) return false;
    const actionKeywords = ['좋아', 'like', '답글', 'reply', '리포스트', 'repost', '공유', 'share'];
    const svgs = scopeEl.querySelectorAll('svg');
    for (const svg of svgs) {
        const label = (
            svg.getAttribute('aria-label') ||
            svg.querySelector('title')?.textContent ||
            svg.getAttribute('title') ||
            svg.closest('button, [role="button"]')?.getAttribute('aria-label') ||
            ''
        ).toLowerCase();
        if (actionKeywords.some(k => label.includes(k))) return true;
    }
    return false;
}

function getDistinctPostCodesInScope(scopeEl) {
    if (!scopeEl || !scopeEl.querySelectorAll) return [];
    const innerQuotes = Array.from(scopeEl.querySelectorAll('div[data-pressable-container="true"]')).filter(
        q => q !== scopeEl && q.parentElement?.closest('div[data-pressable-container="true"]') === scopeEl
    );
    const codes = new Set();
    const links = scopeEl.querySelectorAll('a[href*="/post/"], a[href*="/t/"]');
    for (const a of links) {
        if (innerQuotes.some(iq => iq.contains(a))) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/(?:post|t)\/([^\/?#]+)/);
        if (m && m[1]) codes.add(m[1]);
    }
    return Array.from(codes);
}

function countNonQuoteTimeElements(scopeEl) {
    if (!scopeEl || !scopeEl.querySelectorAll) return 0;
    const innerQuotes = Array.from(scopeEl.querySelectorAll('div[data-pressable-container="true"]')).filter(
        q => q !== scopeEl && q.parentElement?.closest('div[data-pressable-container="true"]') === scopeEl
    );
    const times = Array.from(scopeEl.querySelectorAll('time')).filter(
        t => !innerQuotes.some(iq => iq.contains(t))
    );
    return times.length;
}

function findStrictPostRoot(container) {
    if (!container || container === document.body || container === document.documentElement) return container;

    // 1. container 자체가 data-pressable-container="true"이고 작성자나 시간/링크가 있으면 절대 위로 올라가지 않고 즉시 반환!
    // (상세 페이지 등에서 위로 올라가면 상단 메인 게시글과 합쳐져 엉뚱한 윗글이 스크랩되는 현상 원천 차단)
    const hasDirectAuthor = container.querySelector('a[href^="/@"]:not([href*="/post/"]), a[href*="threads.net/@"]:not([href*="/post/"]), a[href*="threads.com/@"]:not([href*="/post/"])');
    const hasDirectAction = hasActionButtonInScope(container);
    const hasDirectTimeOrLink = !!container.querySelector('time, a[href*="/post/"], a[href*="/t/"]');

    if (container.matches && container.matches('div[data-pressable-container="true"]') && (hasDirectAuthor || hasDirectTimeOrLink)) {
        return container;
    }
    if (hasDirectAuthor && hasDirectAction) {
        return container;
    }

    // 2. 이미 article이나 div[role="article"]인 경우 (내부에 복수의 게시글이 없는 단일 카드일 때만)
    let candidate = container.closest('article, div[role="article"]');
    if (candidate && candidate !== document.body) {
        const pressables = Array.from(candidate.querySelectorAll('div[data-pressable-container="true"]')).filter(p => {
            return !p.parentElement || !p.parentElement.closest('div[data-pressable-container="true"]');
        });
        const candidateCodes = getDistinctPostCodesInScope(candidate);
        const candidateTimes = countNonQuoteTimeElements(candidate);
        if (pressables.length <= 1 && candidateCodes.length <= 1 && candidateTimes <= 1) {
            return candidate;
        }
    }

    // 3. 부모로 올라가며 가장 가까운 개별 포스트 래퍼 탐색 (절대 다른 포스트나 상단 메인 글을 침범하지 않음)
    let cur = container;
    let bestRoot = container;
    for (let i = 0; i < 5; i++) {
        if (!cur || cur === document.body || cur === document.documentElement) break;
        if (candidate && cur === candidate) break;

        if (cur.parentElement) {
            const parent = cur.parentElement;
            const siblingPressables = Array.from(parent.querySelectorAll('div[data-pressable-container="true"]')).filter(p => {
                return !p.parentElement || !p.parentElement.closest('div[data-pressable-container="true"]');
            });
            const parentCodes = getDistinctPostCodesInScope(parent);
            const parentTimes = countNonQuoteTimeElements(parent);
            // 부모에 2개 이상의 pressable이나 2개 이상의 서로 다른 postCode 또는 2개 이상의 time이 있으면
            // 인접 게시글(상단 메인 게시글 또는 답글)을 침범한 것이므로 즉시 중단!
            if (siblingPressables.length > 1 || parentCodes.length > 1 || parentTimes > 1) {
                break;
            }
        }

        const authorLink = cur.querySelector('a[href^="/@"]:not([href*="/post/"]), a[href*="threads.net/@"]:not([href*="/post/"]), a[href*="threads.com/@"]:not([href*="/post/"])');
        const actionBtn = hasActionButtonInScope(cur);

        if (authorLink) {
            bestRoot = cur;
            if (actionBtn) {
                return cur;
            }
        }

        cur = cur.parentElement;
    }

    return bestRoot;
}

function extractPostMeta(postRoot, container) {
    let author = "";
    let postCode = "";

    // 개별 포스트 고유 정보가 담긴 container를 postRoot보다 최우선 탐색하여 스레드 체인 내 상위 원글로의 메타 오염 방지
    const targets = [container, postRoot].filter(Boolean);

    for (const target of targets) {
        if (!target.querySelectorAll) continue;
        // 인용글(내부 중첩 pressable) 내부의 링크는 철저히 배제
        const nestedQuotes = Array.from(target.querySelectorAll('div[data-pressable-container="true"]')).filter(q => q !== target);
        const isInsideNestedQuote = (el) => nestedQuotes.some(nq => nq.contains(el));

        // 1-A. <time> 태그를 감싸고 있는 permalink를 최우선 탐색 (가장 정확한 해당 포스트 고유 링크)
        const timeEls = Array.from(target.querySelectorAll('time')).filter(t => !isInsideNestedQuote(t));
        for (const tEl of timeEls) {
            const timeLink = tEl.closest('a[href*="/post/"], a[href*="/t/"]');
            if (timeLink && target.contains(timeLink) && !isInsideNestedQuote(timeLink)) {
                const href = timeLink.getAttribute('href') || '';
                const pm = href.match(/\/@([^\/\?#]+)\/post\/([^\/\?#]+)/);
                if (pm) {
                    if (!author) author = pm[1];
                    if (!postCode) postCode = pm[2];
                    break;
                }
                const tm = href.match(/\/(?:post|t)\/([^\/\?#]+)/);
                if (tm && !postCode) {
                    postCode = tm[1];
                }
            }
        }

        // 1-B. 일반 post permalink에서 author & postCode 추출
        if (!author || !postCode) {
            const permalinks = Array.from(target.querySelectorAll('a[href*="/post/"], a[href*="/t/"]')).filter(a => !isInsideNestedQuote(a));
            for (const a of permalinks) {
                const href = a.getAttribute('href') || '';
                const pm = href.match(/\/@([^\/\?#]+)\/post\/([^\/\?#]+)/);
                if (pm) {
                    if (!author) author = pm[1];
                    if (!postCode) postCode = pm[2];
                    break;
                }
                const tm = href.match(/\/(?:post|t)\/([^\/\?#]+)/);
                if (tm && !postCode) {
                    postCode = tm[1];
                }
            }
        }

        // 2. author를 아직 못 찾았다면 프로필 링크에서 추출 (인용글 내부 제외)
        if (!author) {
            const authorLinks = Array.from(target.querySelectorAll('a[href^="/@"], a[href*="threads.net/@"], a[href*="threads.com/@"]')).filter(a => !isInsideNestedQuote(a));
            for (const a of authorLinks) {
                const href = a.getAttribute('href') || '';
                if (href.includes('/post/')) continue;
                const um = href.match(/@([a-zA-Z0-9._]+)/);
                if (um) {
                    author = um[1];
                    break;
                }
            }
        }

        if (author && postCode) break;
    }

    // fallback 1: postCode로 기저장된 author 확인
    if (!author && postCode && window.DReaThsStats?.posts?.[postCode]?.author) {
        author = window.DReaThsStats.posts[postCode].author;
    }

    // fallback 2: 프로필 페이지에 있는 경우 현재 프로필 사용자명을 author fallback으로 사용
    if (!author && typeof getProfileUsername === 'function') {
        const profUser = getProfileUsername();
        if (profUser) author = profUser;
    }

    if (author && author.startsWith('@')) author = author.substring(1);
    if (author) author = author.toLowerCase().trim();
    return { author, postCode };
}

// 오디오 스트림(MP4 컨테이너의 오디오 전용 트랙 등) 감지 헬퍼
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

// 영상과 음성이 결합된 Progressive 동영상 감지 헬퍼
function isProgressiveVideoUrl(url) {
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
}

// CDN 비디오 URL에서 부분 청크 파라미터(bytestart, byteend) 제거하여 전체 동영상 다운로드 보장
function cleanVideoUrl(url) {
    if (!url || typeof url !== 'string') return url;
    let cleaned = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    cleaned = cleaned
        .replace(/([?&])bytestart=\d+(&|$)/g, '$1')
        .replace(/([?&])byteend=\d+(&|$)/g, '$1')
        .replace(/[?&]+$/, '')
        .replace(/\?&+/g, '?')
        .replace(/&&+/g, '&');
    return cleaned;
}

// DASH Manifest XML에서 비디오 전용 AdaptationSet 추출 헬퍼 (오디오 절대 제외)
function extractVideoFromDashManifest(manifest) {
    if (typeof manifest !== 'string' || !manifest.includes('<BaseURL>')) return null;
    const clean = manifest.replace(/&amp;/g, '&').replace(/\\\//g, '/');

    const adaptationMatches = [...clean.matchAll(/<AdaptationSet([^>]*?)>([\s\S]*?)<\/AdaptationSet>/gi)];
    let bestUrl = null;
    let maxQuality = -1;

    const inspectRepresentations = (scopeStr) => {
        const repMatches = [...scopeStr.matchAll(/<Representation([^>]*?)>([\s\S]*?)<\/Representation>/gi)];
        for (const rm of repMatches) {
            const attrs = rm[1] || '';
            const body = rm[2] || '';
            if (/mimeType="audio/i.test(attrs) || /contentType="audio/i.test(attrs)) continue;
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
            const score = (width * height) > 0 ? (width * height * 1000 + bw) : bw;

            if (score > maxQuality) {
                maxQuality = score;
                bestUrl = candidateUrl;
            }
        }
    };

    if (adaptationMatches.length > 0) {
        for (const am of adaptationMatches) {
            const aAttrs = am[1] || '';
            const aBody = am[2] || '';
            if (/contentType="audio"/i.test(aAttrs) || /mimeType="audio/i.test(aAttrs)) continue;
            inspectRepresentations(aBody);
        }
    } else {
        inspectRepresentations(clean);
    }

    return bestUrl;
}

// 객체/props에서 최적의 비디오 URL 추출 (다양한 필드 및 Comet/OzPlayer/DASH 매니페스트 지원)
const extractVideoUrl = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;

    // 1. video_versions / videoVersions 배열
    const vVers = obj.video_versions || obj.videoVersions ||
                  obj.clips_metadata?.video_versions || obj.clips_metadata?.videoVersions ||
                  obj.video?.video_versions || obj.video?.videoVersions ||
                  obj.media?.video_versions || obj.media?.videoVersions ||
                  obj.post?.video_versions || obj.post?.videoVersions ||
                  obj.node?.video_versions || obj.node?.videoVersions;
    if (Array.isArray(vVers) && vVers.length > 0) {
        const sorted = [...vVers].sort((a, b) => {
            const pA = isProgressiveVideoUrl(a?.url || a?.uri || a?.src || '') ? 100000000 : 0;
            const pB = isProgressiveVideoUrl(b?.url || b?.uri || b?.src || '') ? 100000000 : 0;
            const qA = pA + ((a?.width && a?.height) ? (a.width * a.height) : (a?.height || 0));
            const qB = pB + ((b?.width && b?.height) ? (b.width * b.height) : (b?.height || 0));
            return qB - qA;
        });
        for (const v of sorted) {
            const u = v?.url || v?.uri || v?.src || v?.playback_url || v?.playbackUrl;
            if (typeof u === 'string' && u.startsWith('http') && !u.includes('rsrc.php') && !isAudioUrl(u)) {
                return cleanVideoUrl(u);
            }
        }
    }

    // 2. Meta Comet / Relay VideoDeliveryResponseResult & progressive_urls 구조
    const deliveryResult = obj.videoDeliveryResponseResult ||
                           obj.video_delivery_response_result ||
                           obj.videoDeliveryResponseFragment?.videoDeliveryResponseResult ||
                           obj.video?.videoDeliveryResponseResult;
    if (deliveryResult && typeof deliveryResult === 'object') {
        const progList = deliveryResult.progressive_urls || deliveryResult.progressiveUrls;
        if (Array.isArray(progList)) {
            let bestProg = null;
            for (const p of progList) {
                const pUrl = p?.progressive_url || p?.progressiveUrl || p?.url || p?.uri;
                if (typeof pUrl === 'string' && pUrl.startsWith('http') && !isAudioUrl(pUrl)) {
                    if (p?.metadata?.quality === 'HD' || p?.quality === 'HD') return cleanVideoUrl(pUrl);
                    if (!bestProg) bestProg = cleanVideoUrl(pUrl);
                }
            }
            if (bestProg) return bestProg;
        }
        const impls = deliveryResult.implementations || deliveryResult.video_implementations;
        if (Array.isArray(impls)) {
            for (const impl of impls) {
                const subData = impl?.data || impl;
                const u = subData?.hdSrc || subData?.sdSrc || subData?.progressive_url || subData?.url;
                if (typeof u === 'string' && u.startsWith('http') && !isAudioUrl(u)) {
                    return cleanVideoUrl(u);
                }
                const dm = subData?.manifest || subData?.dash_manifest;
                if (typeof dm === 'string') {
                    const dv = extractVideoFromDashManifest(dm);
                    if (dv) return dv;
                }
            }
        }
    }

    // 3. 단일 URL 프로퍼티들
    const directKeys = [
        'playable_url_quality_hd', 'playableUrlQualityHd',
        'browser_native_hd_url', 'browserNativeHdUrl',
        'hdSrc', 'hd_src', 'hdSrcNoRatelimit',
        'progressive_download_url', 'progressiveDownloadUrl',
        'progressive_url', 'progressiveUrl',
        'playback_url', 'playbackUrl',
        'playable_url', 'playableUrl',
        'browser_native_sd_url', 'browserNativeSdUrl',
        'sdSrc', 'sd_src',
        'video_url', 'videoUrl',
        'video_src', 'videoSrc',
        'src'
    ];
    for (const key of directKeys) {
        const val = obj[key];
        if (typeof val === 'string' && val.startsWith('http') && !val.includes('rsrc.php') && !isAudioUrl(val)) {
            if (key === 'src' && !val.includes('.mp4') && !val.includes('/v/t') && !val.includes('/o1/v/')) continue;
            return cleanVideoUrl(val);
        }
        for (const subKey of ['video', 'media', 'post', 'node', 'videoData', 'video_data']) {
            const sub = obj[subKey];
            if (sub && typeof sub === 'object' && typeof sub[key] === 'string' && sub[key].startsWith('http') && !sub[key].includes('rsrc.php') && !isAudioUrl(sub[key])) {
                if (key === 'src' && !sub[key].includes('.mp4') && !sub[key].includes('/v/t') && !sub[key].includes('/o1/v/')) continue;
                return cleanVideoUrl(sub[key]);
            }
        }
    }

    // 4. videoData.urls / progressive_urls 배열
    const urlArrays = [obj.videoData?.urls, obj.video_data?.urls, obj.progressive_urls, obj.progressiveUrls];
    for (const arr of urlArrays) {
        if (Array.isArray(arr)) {
            for (const entry of arr) {
                const u = typeof entry === 'string' ? entry : (entry?.progressive_url || entry?.url || entry?.uri || entry?.src);
                if (typeof u === 'string' && u.startsWith('http') && !isAudioUrl(u)) {
                    return cleanVideoUrl(u);
                }
            }
        }
    }

    // 5. DASH Manifest XML 내 BaseURL 추출
    const manifest = obj.video_dash_manifest || obj.dash_manifest || obj.dashManifest || obj.videoDashManifest ||
                     obj.video?.video_dash_manifest || obj.video?.dash_manifest || obj.media?.video_dash_manifest;
    if (manifest) {
        const dashVideo = extractVideoFromDashManifest(manifest);
        if (dashVideo) return dashVideo;
    }

    return null;
};

const extractBestImageFromCandidateObj = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const candidates = obj.image_versions2?.candidates ||
                       obj.imageVersions2?.candidates ||
                       obj.media?.image_versions2?.candidates ||
                       obj.node?.image_versions2?.candidates;
    if (Array.isArray(candidates) && candidates.length > 0) {
        const sorted = [...candidates].sort((a, b) => {
            const qA = (a?.width && a?.height) ? (a.width * a.height) : (a?.width || 0);
            const qB = (b?.width && b?.height) ? (b.width * b.height) : (b?.width || 0);
            return qB - qA;
        });
        for (const c of sorted) {
            const u = c?.url || c?.uri;
            if (typeof u === 'string' && u.startsWith('http') && !u.includes('rsrc.php') && !u.includes('s150x150')) {
                return u;
            }
        }
    }
    const fallbacks = [
        obj.display_url, obj.displayUrl,
        obj.thumbnail_url, obj.thumbnailUrl,
        obj.media_preview_url,
        obj.image?.uri, obj.image?.url,
        obj.photo?.url, obj.photo?.uri
    ];
    for (const fb of fallbacks) {
        if (typeof fb === 'string' && fb.startsWith('http') && !fb.includes('rsrc.php') && !fb.includes('s150x150')) {
            return fb;
        }
    }
    return null;
};

// 포스트 객체에서 미디어(비디오, 이미지, 캐러셀) 추출 헬퍼
const parsePostMedia = (postObj) => {
    if (!postObj || typeof postObj !== 'object') return [];
    const items = [];
    const seen = new Set();

    const isKnownVideo = postObj.media_type === 2 || 
                         postObj.is_video === true || 
                         postObj.__typename === 'XDTGraphVideo' ||
                         postObj.__typename === 'GraphVideo' ||
                         (postObj.video_duration !== undefined && postObj.video_duration > 0) ||
                         !!postObj.clips_metadata || 
                         !!postObj.video_versions ||
                         !!postObj.videoVersions ||
                         !!postObj.video_dash_manifest ||
                         !!postObj.dash_manifest;

    const isKnownCarousel = postObj.media_type === 8 ||
                            postObj.__typename === 'XDTGraphSidecar' ||
                            postObj.__typename === 'GraphSidecar' ||
                            (typeof postObj.carousel_media_count === 'number' && postObj.carousel_media_count > 1);

    // 1. 캐러셀 미디어 (모든 Meta/Threads 캐러셀 배열 구조 총망라 - 단일 비디오 첨부 객체인 attachments 제외)
    let carousel = postObj.carousel_media ||
                   postObj.carouselMedia ||
                   postObj.carousel_items ||
                   postObj.carouselItems ||
                   postObj.sidecar_children ||
                   postObj.sidecarChildren ||
                   postObj.subposts ||
                   postObj.text_post_app_info?.linked_inline_media?.carousel_media ||
                   postObj.media?.carousel_media;

    if (!Array.isArray(carousel) && postObj.edge_sidecar_to_children?.edges) {
        carousel = postObj.edge_sidecar_to_children.edges.map(e => e?.node || e).filter(Boolean);
    }

    if (Array.isArray(carousel) && carousel.length > 0) {
        carousel.forEach(rawItem => {
            const item = rawItem?.node || rawItem?.media || rawItem;
            if (!item || typeof item !== 'object') return;
            const itemIsExplicitImage = item.media_type === 1 ||
                                        item.media_type === '1' ||
                                        item.media_type === 'PHOTO' ||
                                        item.is_video === false ||
                                        item.__typename === 'XDTGraphImage' ||
                                        item.__typename === 'GraphImage';
            const itemIsVideo = !itemIsExplicitImage && (
                                item.media_type === 2 ||
                                item.is_video === true ||
                                (item.video_duration !== undefined && item.video_duration > 0) ||
                                !!item.video_versions ||
                                !!item.videoVersions ||
                                !!item.video_dash_manifest);
            const bestVideo = itemIsExplicitImage ? null : extractVideoUrl(item);
            const bestImg = extractBestImageFromCandidateObj(item);
            if (bestVideo && !seen.has(bestVideo)) {
                seen.add(bestVideo);
                items.push({ type: 'video', url: bestVideo, thumbnail_url: bestImg || bestVideo });
            } else if (!itemIsVideo && bestImg && !seen.has(bestImg)) {
                seen.add(bestImg);
                items.push({ type: 'image', url: bestImg });
            }
        });
        if (items.length > 0) {
            return items;
        }
    }

    // 2. 단일 비디오
    const bestVideo = extractVideoUrl(postObj);
    const bestImg = extractBestImageFromCandidateObj(postObj);
    if (bestVideo) {
        if (!seen.has(bestVideo)) {
            seen.add(bestVideo);
            items.push({ type: 'video', url: bestVideo, thumbnail_url: bestImg || bestVideo });
        }
        return items;
    }

    // 3. 단일 이미지 (비디오나 캐러셀이 아닐 때만 허용하여 썸네일 1장 덮어쓰기 방지!)
    if (items.length === 0 && !isKnownVideo && !isKnownCarousel && bestImg) {
        if (!seen.has(bestImg)) {
            seen.add(bestImg);
            items.push({ type: 'image', url: bestImg });
        }
    }

    return items;
};

// 미디어 배열 품질 점수 산출 (캐러셀 다중 미디어 & 비디오가 단일 썸네일 이미지에 의해 덮어써지는 현상 방지)
function calcMediaQualityScore(items) {
    if (!Array.isArray(items) || items.length === 0) return 0;
    let score = items.length * 100;
    for (const item of items) {
        if (item.type === 'video' && item.url && !isAudioUrl(item.url)) {
            score += 500;
            if (isProgressiveVideoUrl(item.url)) score += 50;
        } else if (item.type === 'image' && item.url) {
            score += 10;
        }
    }
    return score;
}

function mergeMediaStatsCache(code, newItems) {
    if (!code || !Array.isArray(newItems) || newItems.length === 0) return;
    if (!window.DReaThsStats) window.DReaThsStats = { followers: {}, views: {}, posts: {}, profiles: {}, media: {} };
    if (!window.DReaThsStats.media) window.DReaThsStats.media = {};

    const cleanNew = newItems.filter(m => m && m.url);
    if (cleanNew.length === 0) return;

    const existing = window.DReaThsStats.media[code];
    if (!existing || !Array.isArray(existing) || existing.length === 0) {
        window.DReaThsStats.media[code] = cleanNew;
        return;
    }

    // ★ 기존 캐시가 [이미지 + 비디오] 복합 캐러셀인데, 새로 들어온 데이터가 동일 이하 개수의 [비디오만]인 경우 덮어쓰기 원천 차단!
    if (existing.length > 1 && cleanNew.length <= existing.length) {
        const existingHasImgAndVid = existing.some(m => m.type === 'image') && existing.some(m => m.type === 'video');
        const newHasOnlyVideo = cleanNew.every(m => m.type === 'video');
        if (existingHasImgAndVid && newHasOnlyVideo) {
            return;
        }
    }

    const oldScore = calcMediaQualityScore(existing);
    const newScore = calcMediaQualityScore(cleanNew);

    if (newScore >= oldScore) {
        window.DReaThsStats.media[code] = cleanNew;
    } else if (existing.length > 1 && cleanNew.length === 1 && cleanNew[0].type === 'video') {
        // ★ 중요: 절대 기존 캐러셀의 image 슬롯(m.type === 'image')을 video로 덮어쓰지 말 것!
        // (1번 이미지 + 2번 영상 캐러셀에서 1번 이미지가 영상으로 치환되어 영상 2개가 되는 치명적 버그 원인)
        // 오직 기존 video 슬롯(m.type === 'video')이 비어있거나 Progressive URL로 업그레이드할 때만 교체!
        const vUrl = cleanNew[0].url;
        if (vUrl && isProgressiveVideoUrl(vUrl)) {
            let upgraded = false;
            const updated = existing.map(m => {
                if (!upgraded && m.type === 'video' && (!m.url || !isProgressiveVideoUrl(m.url))) {
                    upgraded = true;
                    return { ...m, url: vUrl };
                }
                return m;
            });
            if (upgraded) window.DReaThsStats.media[code] = updated;
        }
    }
}

// JSON 객체 트리에서 특정 postCode(또는 전체 포스트)의 미디어를 깊이 150까지 안전하게 탐색
function findPostMediaInJsonTree(rootNode, targetPostCode = null) {
    let bestItems = [];
    const visited = typeof WeakSet !== 'undefined' ? new WeakSet() : null;

    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 150) return;
        if (visited) {
            if (visited.has(node)) return;
            visited.add(node);
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) walk(node[i], depth + 1);
            return;
        }

        const nCode = node.code || node.shortcode || node.post_code;
        if (nCode && typeof nCode === 'string' && nCode.length > 3) {
            const parsed = parsePostMedia(node);
            if (parsed.length > 0) {
                mergeMediaStatsCache(nCode, parsed);
                if (targetPostCode && nCode === targetPostCode) {
                    if (calcMediaQualityScore(parsed) > calcMediaQualityScore(bestItems)) {
                        bestItems = parsed;
                    }
                }
            }
        }

        for (const k of Object.keys(node)) {
            const v = node[k];
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };

    walk(rootNode, 0);
    return bestItems;
}

// 상세 페이지 HTML 문자열에서 특정 postCode의 정밀 미디어 추출 (SSR <script type="application/json"> 파싱)
function extractMediaFromPostDetailHtml(html, targetPostCode) {
    if (!html || typeof html !== 'string' || !targetPostCode) return [];
    let bestItems = [];
    try {
        const scriptRegex = /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = scriptRegex.exec(html)) !== null) {
            const scriptContent = match[1];
            if (!scriptContent || !scriptContent.includes(targetPostCode)) continue;
            try {
                const parsed = JSON.parse(scriptContent);
                const found = findPostMediaInJsonTree(parsed, targetPostCode);
                if (calcMediaQualityScore(found) > calcMediaQualityScore(bestItems)) {
                    bestItems = found;
                }
            } catch (e) {}
        }
    } catch (e) {}
    if (bestItems.length > 0) {
        mergeMediaStatsCache(targetPostCode, bestItems);
    }
    return bestItems;
}

// ==========================================
// 3. 스크랩 처리 (이슈 1~5 통합 해결 - 컨테이너 격리 및 온디맨드 정밀 미디어 추출)
// ==========================================
async function processContainer(selectedContainer, extraContext = {}) {
    let rawContent = "";
    let mediaItems = [];

    // 0. 전달된 컨테이너 및 컨텍스트 정리
    // ★ 핵심: postRoot가 아닌 개별 포스트 카드(extraContext.container 또는 selectedContainer)를 최우선 사용!
    // postRoot에 querySelector('[data-pressable-container="true"]')를 호출하면
    // 상세 페이지 상단 원글이나 첫 번째 답글, 혹은 인용글이 선택되는 치명적 버그가 발생하므로 절대 금지!
    const rawTarget = extraContext.container || selectedContainer;
    if (!rawTarget) return;

    let mainPost = rawTarget;
    let pressableContainer = null;

    if (mainPost.matches && mainPost.matches('[data-pressable-container="true"]')) {
        pressableContainer = mainPost;
    } else if (mainPost.closest) {
        const closestPressable = mainPost.closest('[data-pressable-container="true"]');
        if (closestPressable) {
            pressableContainer = closestPressable;
        }
    }
    if (!pressableContainer && mainPost.querySelector) {
        // mainPost 내부에 pressable이 단 1개이고, 인용글이 아닌 경우에만 허용
        const childPressables = Array.from(mainPost.querySelectorAll('[data-pressable-container="true"]')).filter(
            p => !p.parentElement?.closest('[data-pressable-container="true"]')
        );
        if (childPressables.length === 1 && countNonQuoteTimeElements(mainPost) <= 1) {
            pressableContainer = childPressables[0];
        }
    }
    if (!pressableContainer) pressableContainer = mainPost;

    // postRoot 식별: 엄격한 포스트 루트 탐색 (절대 다른 포스트로 확장되지 않음)
    let postRoot = findStrictPostRoot(pressableContainer);
    if (!postRoot) postRoot = pressableContainer;

    // DOM에서 직접 메타데이터(author, postCode) 추출 (pressableContainer 최우선!)
    const domMeta = extractPostMeta(postRoot, pressableContainer);

    let extractedPostCode = domMeta.postCode || extraContext.postCode || "";
    let extractedAuthor = domMeta.author || extraContext.author || "";

    // ★ 교차 검증: 만약 DOM에서 감지된 작성자/포스트코드가 extraContext와 불일치한다면 DOM 기준으로 즉시 정정
    if (domMeta.postCode && extraContext.postCode && domMeta.postCode !== extraContext.postCode) {
        extractedPostCode = domMeta.postCode;
    }
    if (domMeta.author && extraContext.author && domMeta.author !== extraContext.author) {
        console.warn(`[DReaThs] 작성자 불일치 감지: extraContext=${extraContext.author} vs DOM=${domMeta.author} -> DOM 기준 정정`);
        extractedAuthor = domMeta.author;
        if (domMeta.postCode) {
            extractedPostCode = domMeta.postCode;
        }
    }

    // URL Pathname Fallback: 오직 현재 페이지가 상세 페이지이고, 선택한 컨테이너가 상세 페이지의 메인 최상단 게시물일 때만 허용!
    // (상세 페이지 하단 답글/추천글을 스크랩할 때 상단 메인 게시물의 postCode로 덮어써지는 버그 완벽 차단)
    if (!extractedPostCode || !extractedAuthor) {
        const pathMatch = window.location.pathname.match(/\/@([^\/\?#]+)\/post\/([^\/\?#]+)/);
        if (pathMatch) {
            const pathAuthor = pathMatch[1].toLowerCase().trim();
            const pathCode = pathMatch[2];
            const isMainDetailPost = (!extractedAuthor || extractedAuthor === pathAuthor) &&
                                     (!extractedPostCode || extractedPostCode === pathCode) &&
                                     !pressableContainer.matches?.('div[data-pressable-container="true"]');
            if (isMainDetailPost) {
                if (!extractedAuthor) extractedAuthor = pathAuthor;
                if (!extractedPostCode) extractedPostCode = pathCode;
            }
        }
    }

    const mediaContainer = pressableContainer || mainPost;

    // 인용글(Nested Quote Card)만 정확하게 선별: mediaContainer 자신은 절대 제외!
    const quoteSelector = '[data-pressable-container="true"]';
    const allInner = mediaContainer.querySelectorAll ? Array.from(mediaContainer.querySelectorAll(quoteSelector)) : [];
    const innerQuotes = allInner.filter(q => q !== mediaContainer);

    // ★ 컨테이너 내부 실제 DOM 미디어 개수 및 상태 사전 진단 (캐러셀/비디오 누락 감지용)
    const isProfileAvatarImg = (img) => {
        const src = img.currentSrc || img.getAttribute('src') || '';
        const alt = (img.getAttribute('alt') || '').toLowerCase();
        if (!src || !src.startsWith('http') || src.includes('rsrc.php') || src.includes('s150x150')) return true;
        if (alt.includes('profile') || alt.includes('프로필') || alt.includes('아바타') || alt.includes('avatar')) return true;
        const aTag = img.closest('a[href*="/@"]');
        if (aTag) {
            const href = aTag.getAttribute('href') || '';
            if (!href.includes('/post/')) return true;
        }
        const rect = img.getBoundingClientRect();
        if ((rect.width > 0 && rect.width < 48) || (rect.height > 0 && rect.height < 48)) return true;
        const attrW = parseInt(img.getAttribute('width') || '0', 10);
        const attrH = parseInt(img.getAttribute('height') || '0', 10);
        if ((attrW > 0 && attrW < 48) || (attrH > 0 && attrH < 48)) return true;
        return false;
    };

    const domVideos = mediaContainer.querySelectorAll
        ? Array.from(mediaContainer.querySelectorAll('video')).filter(v => !innerQuotes.some(iq => iq.contains(v)))
        : [];

    // DOM 에는 <video> 가 있으나 원본 CDN 주소를 찾지 못한 영상 기록 (스크랩 실패 판정/리포트용)
    const domUnresolvedVideos = [];

    // ★ 비디오 커버/포스터 이미지 정밀 판별기
    // (1. 단일 영상의 커버 <img>는 확실히 제외하고, 2. [이미지 1개 + 영상 1개] 2열 배치에서 옆에 있는 독립 이미지는 절대 포스터로 오판하지 않음!)
    const isImgPosterForVideo = (img) => {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (src.includes('video_default_cover_frame')) return true;
        if (domVideos.length === 0) return false;

        const imgSlide = img.closest('li, [role="listitem"]');
        const imgRect = img.getBoundingClientRect();

        for (const vid of domVideos) {
            const vidSlide = vid.closest('li, [role="listitem"]');
            // 명시적 li 슬라이드가 존재하고 같은 슬라이드 내부이면 해당 비디오의 포스터
            if (imgSlide && vidSlide && imgSlide === vidSlide) return true;

            const vidRect = vid.getBoundingClientRect();
            if (imgRect.width > 0 && vidRect.width > 0) {
                // 둘 다 화면에 렌더링된 상태라면, 비디오 플레이어와 동일한 좌표 영역에 겹쳐진 경우에만 포스터!
                // (2열 캐러셀에서 좌측 이미지와 우측 비디오처럼 X/Y 좌표가 떨어져 있으면 별개의 이미지 슬라이드임)
                if (Math.abs(imgRect.left - vidRect.left) < 35 && Math.abs(imgRect.top - vidRect.top) < 35) {
                    return true;
                }
            } else {
                // 숨겨진 포스터(width===0)인 경우 직계 플레이어 래퍼(depth <= 2) 내부에 해당 video가 있는지만 확인
                let cur = img.parentElement;
                let depth = 0;
                while (cur && cur !== mediaContainer && depth <= 2) {
                    if (cur.contains(vid)) return true;
                    cur = cur.parentElement;
                    depth++;
                }
            }
        }
        return false;
    };

    const domValidImgs = mediaContainer.querySelectorAll
        ? Array.from(mediaContainer.querySelectorAll('img')).filter(img =>
            !innerQuotes.some(iq => iq.contains(img)) &&
            !isProfileAvatarImg(img) &&
            !isImgPosterForVideo(img)
        )
        : [];
    const hasDomVideo = domVideos.length > 0;
    const hasCarouselDomHint = !!(
        mediaContainer.querySelector &&
        (
            mediaContainer.querySelector('button[aria-label*="다음"], button[aria-label*="Next"], div[role="button"][aria-label*="다음"], div[role="button"][aria-label*="Next"], ul li img, ul li video') ||
            (domValidImgs.length + domVideos.length > 1)
        )
    );
    const expectedMinMediaCount = Math.max(
        hasCarouselDomHint ? 2 : 0,
        domVideos.length + domValidImgs.length
    );

    // 1. MAIN world(interceptor.js)에 현재 선택한 DOM 컨테이너 전용 정밀 Fiber 스캔 즉시 요청 (Relay Data Masking 우회)
    try {
        document.querySelectorAll('[data-dreaths-scrap-target]').forEach(el => el.removeAttribute('data-dreaths-scrap-target'));
        mediaContainer.setAttribute('data-dreaths-scrap-target', 'true');
        mediaContainer.removeAttribute('data-dreaths-extracted-media');
        window.postMessage({
            type: 'DREATHS_EXTRACT_CONTAINER_MEDIA',
            postCode: extractedPostCode || null
        }, '*');
        await new Promise(r => setTimeout(r, 85));

        const attrRaw = mediaContainer.getAttribute('data-dreaths-extracted-media');
        if (attrRaw) {
            const parsedAttr = JSON.parse(attrRaw);
            const attrCode = parsedAttr.postCode || parsedAttr.code;
            const attrMedia = parsedAttr.media || parsedAttr.mediaItems;
            if (!extractedPostCode && attrCode) {
                extractedPostCode = attrCode;
            }
            if (Array.isArray(attrMedia) && attrMedia.length > 0) {
                mediaItems = attrMedia;
                if (extractedPostCode) {
                    mergeMediaStatsCache(extractedPostCode, attrMedia);
                }
            }
        }
        mediaContainer.removeAttribute('data-dreaths-scrap-target');
    } catch (e) {}

    // 2. GraphQL / React Fiber 글로벌 캐시와 병합 비교 (더 품질 점수가 높은 미디어 채택)
    if (extractedPostCode && window.DReaThsStats?.media?.[extractedPostCode]) {
        const postData = window.DReaThsStats.posts && window.DReaThsStats.posts[extractedPostCode];
        if (!postData || !postData.author || !extractedAuthor || postData.author.toLowerCase().trim() === extractedAuthor.toLowerCase().trim()) {
            const cachedMedia = window.DReaThsStats.media[extractedPostCode];
            if (Array.isArray(cachedMedia) && cachedMedia.length > 0) {
                const hasCorruptAudio = cachedMedia.some(m => m.type === 'video' && isAudioUrl(m.url));
                if (!hasCorruptAudio && calcMediaQualityScore(cachedMedia) > calcMediaQualityScore(mediaItems)) {
                    mediaItems = JSON.parse(JSON.stringify(cachedMedia));
                }
            }
        }
    }

    const isMediaStillIncomplete = () => {
        if (!mediaItems || mediaItems.length === 0) return true;
        if (hasDomVideo && !mediaItems.some(m => m.type === 'video' && m.url && !isAudioUrl(m.url))) return true;
        // DOM에 독립된 일반 이미지가 존재하는데(예: 이미지1+영상1) 추출된 결과에 이미지가 하나도 없다면 미완성!
        if (domValidImgs.length > 0 && !mediaItems.some(m => m.type === 'image' && m.url)) return true;
        if (hasCarouselDomHint && mediaItems.length < 2) return true;
        if (expectedMinMediaCount > 1 && mediaItems.length < expectedMinMediaCount) return true;
        return false;
    };

    // 2-1. 미디어가 아직 없거나 불완전한 경우, 현재 페이지의 <script type="application/json"> (SSR 데이터)에서 깊이 150으로 정밀 탐색
    if (extractedPostCode && isMediaStillIncomplete()) {
        try {
            document.querySelectorAll('script[type="application/json"], script:not([src])').forEach(script => {
                const text = script.innerHTML;
                if (!text || !text.includes(extractedPostCode)) return;
                try {
                    const parsed = JSON.parse(text);
                    const found = findPostMediaInJsonTree(parsed, extractedPostCode);
                    if (calcMediaQualityScore(found) > calcMediaQualityScore(mediaItems)) {
                        mediaItems = JSON.parse(JSON.stringify(found));
                        console.log(`[DReaThs] <script> JSON 파싱으로 ${extractedPostCode} 미디어 추출 성공 (${mediaItems.length}개):`, mediaItems);
                    }
                } catch (pe) {}
            });
        } catch (e) {}
    }

    // 2-2. ★ 온디맨드 상세 페이지(/t/postCode) SSR Fetch:
    // 피드에서 10분이 경과했거나 Relay 마스킹으로 인해 캐러셀 일부/동영상 원본 URL이 누락된 경우,
    // 해당 게시글의 고유 상세 페이지를 즉시 백그라운드 조회하여 100% 정확한 원본 미디어 전체를 확보!
    if (extractedPostCode && isMediaStillIncomplete()) {
        try {
            console.log(`[DReaThs] ${extractedPostCode} 미디어 보완을 위해 온디맨드 상세 데이터 조회 중...`);
            const detailUrl = `${location.origin}/t/${extractedPostCode}`;
            const resp = await fetch(detailUrl, {
                credentials: 'include',
                headers: { 'Accept': 'text/html' }
            });
            if (resp.ok) {
                const detailHtml = await resp.text();
                const detailMedia = extractMediaFromPostDetailHtml(detailHtml, extractedPostCode);
                if (calcMediaQualityScore(detailMedia) > calcMediaQualityScore(mediaItems)) {
                    mediaItems = JSON.parse(JSON.stringify(detailMedia));
                    console.log(`[DReaThs] 온디맨드 상세 조회로 ${extractedPostCode} 미디어 완벽 복원 (${mediaItems.length}개):`, mediaItems);
                }
            }
        } catch (fetchErr) {
            console.warn('[DReaThs] 온디맨드 상세 조회 실패:', fetchErr);
        }
    }

    // 동영상 썸네일 추출 헬퍼 (Canvas 캡처)
    const extractVideoThumbnail = (videoUrl) => {
        return new Promise((resolve) => {
            if (!videoUrl || !videoUrl.startsWith('http')) return resolve(null);
            const video = document.createElement('video');
            video.src = videoUrl;
            video.crossOrigin = 'anonymous';
            video.currentTime = 0.5;
            video.muted = true;
            video.playsInline = true;

            const timeout = setTimeout(() => {
                video.onseeked = null;
                video.onerror = null;
                resolve(null);
            }, 5000);

            video.onseeked = () => {
                clearTimeout(timeout);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = video.videoWidth || 640;
                    canvas.height = video.videoHeight || 360;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
                    resolve(dataUrl);
                } catch (e) {
                    resolve(null);
                }
            };

            video.onerror = () => {
                clearTimeout(timeout);
                resolve(null);
            };

            video.load();
        });
    };

    let likes = null, comments = null, reposts = null, shares = null, views = null;
    let mainPostTextObj = { author: extractedAuthor || 'Unknown', category: '', postDate: '', text: '' };

    const originalDisplays = [];
    innerQuotes.forEach(q => {
        originalDisplays.push(q.style.display);
        q.style.display = 'none';
    });

    function parseKoreanNumber(str) {
        if (!str) return null;
        let numStr = str.replace(/,/g, '');
        let multiplier = 1;
        if (numStr.includes('만')) { multiplier = 10000; numStr = numStr.replace('만', ''); }
        else if (numStr.includes('천')) { multiplier = 1000; numStr = numStr.replace('천', ''); }
        const parsed = parseFloat(numStr);
        return isNaN(parsed) ? null : Math.floor(parsed * multiplier);
    }

    const statsScope = postRoot || mediaContainer;
    const statsText = statsScope.innerText || '';

    const likeMatch = statsText.match(/좋아요\s*([0-9,.]+(?:만|천)?)\s*개/);
    if (likeMatch) likes = parseKoreanNumber(likeMatch[1]);
    const commentMatch = statsText.match(/답글\s*([0-9,.]+(?:만|천)?)\s*개/);
    if (commentMatch) comments = parseKoreanNumber(commentMatch[1]);
    const repostMatch = statsText.match(/리포스트\s*([0-9,.]+(?:만|천)?)\s*(?:회|개)?/);
    if (repostMatch) reposts = parseKoreanNumber(repostMatch[1]);
    const shareMatch = statsText.match(/공유하기\s*([0-9,.]+(?:만|천)?)\s*(?:회|개)?/);
    if (shareMatch) shares = parseKoreanNumber(shareMatch[1]);
    const viewMatch = statsText.match(/조회\s*([0-9,.]+(?:만|천)?)\s*회/);
    if (viewMatch) views = parseKoreanNumber(viewMatch[1]);

    // SVG 아이콘 기반 통계 추출 (aria-label 및 <title> 모두 지원)
    const extractStatFromSvg = (keyword) => {
        if (!statsScope.querySelectorAll) return null;
        const kwLower = keyword.toLowerCase();
        const svgs = statsScope.querySelectorAll('svg');
        for (let svg of svgs) {
            if (innerQuotes.some(iq => iq.contains(svg))) continue;
            const label = (
                svg.getAttribute('aria-label') ||
                svg.querySelector('title')?.textContent ||
                svg.getAttribute('title') ||
                svg.closest('button, [role="button"]')?.getAttribute('aria-label') ||
                ''
            ).toLowerCase();
            if (!label.includes(kwLower)) continue;
            const container = svg.closest('div[role="button"], button') || svg.parentElement?.parentElement?.parentElement;
            if (!container) continue;
            const textMatch = (container.innerText || '').match(/([0-9,.]+(?:만|천)?)/);
            if (textMatch) return parseKoreanNumber(textMatch[1]);
        }
        return null;
    };

    if (!likes) likes = extractStatFromSvg('좋아') || extractStatFromSvg('like');
    if (!comments) comments = extractStatFromSvg('답글') || extractStatFromSvg('reply') || extractStatFromSvg('comment');
    if (!reposts) reposts = extractStatFromSvg('리포스트') || extractStatFromSvg('repost');
    if (!shares) shares = extractStatFromSvg('공유') || extractStatFromSvg('share');

    // extraContext 및 글로벌 캐시 fallback
    if (!likes && extraContext.likes !== undefined && extraContext.likes !== null) likes = extraContext.likes;
    if (!comments && extraContext.comments !== undefined && extraContext.comments !== null) comments = extraContext.comments;
    if (!reposts && extraContext.reposts !== undefined && extraContext.reposts !== null) reposts = extraContext.reposts;
    if (!shares && extraContext.shares !== undefined && extraContext.shares !== null) shares = extraContext.shares;
    if (!views && extraContext.views !== undefined && extraContext.views !== null) views = extraContext.views;
    if (!views && extractedPostCode && window.DReaThsStats?.views?.[extractedPostCode]) views = window.DReaThsStats.views[extractedPostCode];

    // 3. DOM 직접 미디어 추출 (캐시/SSR/온디맨드 조회 후에도 미디어가 부족하거나 비디오가 누락된 경우 보완)
    if (isMediaStillIncomplete() && mediaContainer.querySelectorAll) {
        const domExtracted = [];
        const domSeenUrls = new Set();

        // 이미지 추출 (비디오 포스터는 이미 domValidImgs에서 제외됨)
        domValidImgs.forEach(img => {
            if (isImgPosterForVideo(img)) return;
            const src = img.currentSrc || img.getAttribute('src') || '';
            if (src && src.startsWith('http') && !domSeenUrls.has(src)) {
                domSeenUrls.add(src);
                domExtracted.push({ type: 'image', url: src });
            }
        });

        // 비디오 추출
        for (const vid of domVideos) {
            let videoUrl = vid.currentSrc || vid.getAttribute('src') || vid.src || '';
            if (!videoUrl) {
                const srcSource = vid.querySelector('source');
                if (srcSource) videoUrl = srcSource.getAttribute('src') || srcSource.currentSrc || '';
            }

            let capturedFrameBase64 = null;
            try {
                if (vid.readyState >= 1 || vid.videoWidth > 0) {
                    const canvas = document.createElement('canvas');
                    canvas.width = vid.videoWidth || 640;
                    canvas.height = vid.videoHeight || 360;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
                    capturedFrameBase64 = canvas.toDataURL('image/jpeg', 0.85);
                }
            } catch (cErr) {}

            let coverImgUrl = vid.getAttribute('poster') || vid.poster || '';
            if (!coverImgUrl) {
                const slideScope = vid.closest('li, [role="listitem"]') || vid.parentElement?.parentElement?.parentElement || mediaContainer;
                if (slideScope && slideScope.querySelectorAll) {
                    const siblingImgs = slideScope.querySelectorAll('img');
                    for (const sImg of siblingImgs) {
                        if (innerQuotes.some(iq => iq.contains(sImg))) continue;
                        const sSrc = sImg.currentSrc || sImg.src || '';
                        if (sSrc.startsWith('http') && !isProfileAvatarImg(sImg) && isImgPosterForVideo(sImg)) {
                            coverImgUrl = sSrc;
                            break;
                        }
                    }
                }
            }

            let realCdnUrl = '';
            // 0순위: vid 요소의 실제 http src
            if (videoUrl.startsWith('http://') || videoUrl.startsWith('https://')) {
                if (!videoUrl.includes('static.cdninstagram.com') && !videoUrl.includes('rsrc.php') && !isAudioUrl(videoUrl)) {
                    realCdnUrl = cleanVideoUrl(videoUrl);
                }
            }

            // 1순위: MAIN world(interceptor.js)가 바인딩한 data-dreaths-video-url
            if (!realCdnUrl) {
                const bUrl = vid.getAttribute('data-dreaths-video-url') || '';
                if (bUrl && !isAudioUrl(bUrl)) realCdnUrl = cleanVideoUrl(bUrl);
            }

            // 2순위: 글로벌 캐시에서 해당 postCode의 비디오 확인
            if (!realCdnUrl && extractedPostCode && window.DReaThsStats?.media?.[extractedPostCode]) {
                const cItems = window.DReaThsStats.media[extractedPostCode];
                const vItem = cItems.find(m => m.type === 'video' && m.url && m.url.startsWith('http') && !isAudioUrl(m.url));
                if (vItem) {
                    realCdnUrl = cleanVideoUrl(vItem.url);
                    if (!coverImgUrl && vItem.thumbnail_url) coverImgUrl = vItem.thumbnail_url;
                }
            }

            // 3순위: MAIN world에 On-Demand Fiber 비디오 추출 요청
            if (!realCdnUrl) {
                try {
                    window.postMessage({ type: 'DREATHS_EXTRACT_TARGET_VIDEO', postCode: extractedPostCode }, '*');
                    await new Promise(r => setTimeout(r, 180));
                    const bUrl = vid.getAttribute('data-dreaths-video-url') || '';
                    if (bUrl && !isAudioUrl(bUrl)) realCdnUrl = cleanVideoUrl(bUrl);
                    if (!realCdnUrl && extractedPostCode && window.DReaThsStats?.media?.[extractedPostCode]) {
                        const cItems = window.DReaThsStats.media[extractedPostCode];
                        const vItem = cItems.find(m => m.type === 'video' && m.url && m.url.startsWith('http') && !isAudioUrl(m.url));
                        if (vItem) {
                            realCdnUrl = cleanVideoUrl(vItem.url);
                            if (!coverImgUrl && vItem.thumbnail_url) coverImgUrl = vItem.thumbnail_url;
                        }
                    }
                } catch (reqErr) {}
            }

            if (!realCdnUrl) {
                domUnresolvedVideos.push({
                    stage: 'DOM_VIDEO_URL_NOT_FOUND',
                    url: videoUrl || coverImgUrl || '',
                    reason: 'DOM <video> 는 있으나 원본 영상 CDN 주소를 찾지 못함' + (videoUrl.startsWith('blob:') ? ' (blob: 주소)' : '')
                });
            }

            if (realCdnUrl && !domSeenUrls.has(realCdnUrl)) {
                domSeenUrls.add(realCdnUrl);
                if (coverImgUrl) {
                    const coverBase = coverImgUrl.split('?')[0];
                    for (let i = domExtracted.length - 1; i >= 0; i--) {
                        if (domExtracted[i].type === 'image' && domExtracted[i].url.split('?')[0] === coverBase) {
                            domExtracted.splice(i, 1);
                        }
                    }
                }
                domExtracted.push({
                    type: 'video',
                    url: realCdnUrl,
                    thumbnail_url: coverImgUrl || realCdnUrl,
                    thumbnail_base64: capturedFrameBase64 || undefined
                });
                console.log('[DReaThs] 동영상 원본 CDN 주소 추출 성공:', realCdnUrl);
            } else if (!realCdnUrl && (coverImgUrl || capturedFrameBase64)) {
                const fallbackUrl = coverImgUrl || '';
                if (fallbackUrl && !domSeenUrls.has(fallbackUrl)) {
                    domSeenUrls.add(fallbackUrl);
                    domExtracted.push({
                        type: 'image',
                        url: fallbackUrl,
                        thumbnail_url: coverImgUrl || undefined,
                        thumbnail_base64: capturedFrameBase64 || undefined
                    });
                }
            }
        }

        // 기존 mediaItems와 domExtracted 병합:
        // 만약 기존 mediaItems가 [비디오만]이고 domExtracted가 [이미지 + 비디오]라면 domExtracted를 우선 채택!
        const mediaHasImg = mediaItems.some(m => m.type === 'image');
        const domHasImgAndVid = domExtracted.some(m => m.type === 'image') && domExtracted.some(m => m.type === 'video');
        if ((!mediaHasImg && domHasImgAndVid) || calcMediaQualityScore(domExtracted) > calcMediaQualityScore(mediaItems)) {
            mediaItems = domExtracted;
        } else if (domExtracted.length > mediaItems.length) {
            const existingBaseUrls = new Set(mediaItems.map(m => (m.url || '').split('?')[0]));
            const existingThumbUrls = new Set(mediaItems.filter(m => m.type === 'video' && m.thumbnail_url).map(m => m.thumbnail_url.split('?')[0]));
            for (const dItem of domExtracted) {
                const dBase = (dItem.url || '').split('?')[0];
                if (dBase && !existingBaseUrls.has(dBase) && !existingThumbUrls.has(dBase)) {
                    existingBaseUrls.add(dBase);
                    mediaItems.push(dItem);
                }
            }
        }
    }

    // DOM에서 확인된 실제 독립 이미지(비디오 포스터가 아닌 일반 이미지 슬라이드)의 Base URL 집합
    const domStandaloneImgBases = new Set(
        domValidImgs
            .map(img => (img.currentSrc || img.getAttribute('src') || '').split('?')[0])
            .filter(Boolean)
    );

    // ★ 최종 정리 1: 비디오가 존재할 때, 비디오의 thumbnail_url 또는 video_default_cover_frame 커버 이미지가 별도 이미지로 중복 포함되어 있으면 제거
    // (단, DOM에서 독립된 슬라이드로 확인된 domStandaloneImgBases 이미지는 절대 삭제하지 않음!)
    const hasAnyValidVideo = mediaItems.some(m => m.type === 'video' && m.url && !isAudioUrl(m.url));
    const videoThumbs = new Set(
        mediaItems
            .filter(m => m.type === 'video' && m.thumbnail_url)
            .map(m => m.thumbnail_url.split('?')[0])
            .filter(Boolean)
    );
    if (hasAnyValidVideo) {
        mediaItems = mediaItems.filter(m => {
            if (m.type === 'image' && m.url) {
                if (m.url.includes('video_default_cover_frame')) return false;
                const base = m.url.split('?')[0];
                if (videoThumbs.has(base) && !domStandaloneImgBases.has(base)) {
                    return false;
                }
            }
            return true;
        });
    }

    // ★ 최종 정리 2: 동일 비디오의 다중 포맷/화질(DASH m69 vs Progressive m86, HD vs SD) 중복 제거
    // DOM 내 실제 <video> 태그가 1개뿐이고 멀티 비디오 슬라이드(ul li video 여러 개)가 아닌 경우,
    // 비디오는 반드시 최고 품질(Progressive 우선) 1개만 유지하고 이미지 슬라이드는 그대로 보존!
    const domListVideoCount = mediaContainer.querySelectorAll
        ? Array.from(mediaContainer.querySelectorAll('li video, [role="listitem"] video')).filter(v => !innerQuotes.some(iq => iq.contains(v))).length
        : 0;
    const maxExpectedVideos = Math.max(domVideos.length, domListVideoCount);

    if (mediaItems.filter(m => m.type === 'video').length > 1) {
        if (maxExpectedVideos === 1) {
            const validVideos = mediaItems.filter(m => m.type === 'video' && m.url && !isAudioUrl(m.url));
            const bestSingleVideo = validVideos.find(v => isProgressiveVideoUrl(v.url)) || validVideos[0];
            let videoKept = false;
            mediaItems = mediaItems.filter(m => {
                if (m.type !== 'video') return true;
                if (!videoKept && bestSingleVideo) {
                    videoKept = true;
                    m.url = bestSingleVideo.url;
                    if (bestSingleVideo.thumbnail_url) m.thumbnail_url = bestSingleVideo.thumbnail_url;
                    if (bestSingleVideo.thumbnail_base64) m.thumbnail_base64 = bestSingleVideo.thumbnail_base64;
                    return true;
                }
                return false;
            });
        } else {
            const seenVideoBase = new Set();
            const seenThumbBase = new Set();
            mediaItems = mediaItems.filter(m => {
                if (m.type !== 'video') return true;
                const vBase = (m.url || '').split('?')[0];
                const tBase = (m.thumbnail_url && m.thumbnail_url !== m.url) ? m.thumbnail_url.split('?')[0] : '';
                if (vBase && seenVideoBase.has(vBase)) return false;
                if (tBase && seenThumbBase.has(tBase)) return false;
                if (vBase) seenVideoBase.add(vBase);
                if (tBase) seenThumbBase.add(tBase);
                return true;
            });
        }
    }

    // ★ 최종 정리 3: 만약 DOM에 독립된 일반 이미지 슬라이드(domValidImgs)가 존재하는데(예: 이미지 1개 + 영상 1개 게시물)
    // mediaItems에 해당 이미지가 누락되어 있다면 DOM 순서에 맞춰 보충!
    if (domValidImgs.length > 0 && !mediaItems.some(m => m.type === 'image' && m.url)) {
        const recoveredImgs = [];
        const seenImgBase = new Set();
        domValidImgs.forEach(img => {
            const src = img.currentSrc || img.getAttribute('src') || '';
            const base = src.split('?')[0];
            if (src && src.startsWith('http') && !src.includes('video_default_cover_frame') && !seenImgBase.has(base)) {
                seenImgBase.add(base);
                recoveredImgs.push({ type: 'image', url: src });
            }
        });
        if (recoveredImgs.length > 0) {
            const firstImgRect = domValidImgs[0].getBoundingClientRect();
            const firstVidRect = domVideos[0]?.getBoundingClientRect();
            if (firstVidRect && firstImgRect.width > 0 && firstVidRect.width > 0 && firstImgRect.left < firstVidRect.left) {
                mediaItems = [...recoveredImgs, ...mediaItems];
            } else {
                mediaItems = [...mediaItems, ...recoveredImgs];
            }
        }
    }

    // ====== 텍스트 추출 (인용글/액션바 임시 격리) ======
    const authorEl = (mediaContainer || postRoot).querySelector('a[href^="/@"] span[dir="auto"][translate="no"]');
    const authorFromEl = authorEl ? authorEl.innerText.trim() : '';
    const finalAuthor = extractedAuthor || authorFromEl || 'Unknown';

    const tagEl = (mediaContainer || postRoot).querySelector('a[href*="serp_type=tags"] span[dir="auto"]');
    const category = tagEl ? tagEl.innerText.trim() : '';

    const timeEl = (mediaContainer || postRoot).querySelector('time');
    let postDate = '';
    if (timeEl) {
        postDate = timeEl.getAttribute('datetime') || timeEl.innerText.trim();
        if (postDate.includes('T')) postDate = postDate.substring(0, 10);
    }

    const actionLabels = ['좋아요', '답글', '리포스트', '공유하기', '인용', 'Like', 'Reply', 'Repost', 'Share', 'Quote'];
    const hiddenActionEls = [];
    if (mediaContainer.querySelectorAll) {
        mediaContainer.querySelectorAll('svg').forEach(svg => {
            const label = svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || svg.getAttribute('title') || '';
            if (actionLabels.some(al => label.includes(al))) {
                let toHide = svg.closest('div[role="button"], button') || svg.parentElement;
                if (toHide && mediaContainer.contains(toHide)) {
                    hiddenActionEls.push({ el: toHide, orig: toHide.style.display });
                    toHide.style.display = 'none';
                }
            }
        });
    }

    let rawInnerText = mediaContainer.innerText || '';

    // 숨겼던 요소 복원
    innerQuotes.forEach((q, idx) => { q.style.display = originalDisplays[idx]; });
    hiddenActionEls.forEach(({ el, orig }) => { el.style.display = orig; });

    let lines = rawInnerText.split('\n').map(l => l.trim()).filter(Boolean);

    const ignoreWords = [
        '더 보기', '좋아요', '답글', '공유하기', '리포스트', '게시', '숨기기',
        '인기순', '새로운 소식이 있나요?', '홈', '검색', '만들기', '알림', '프로필', 'Enable',
        '번역 보기', '원문 보기', '번역 평가하기', '번역', '번역하기',
        '오디오 소리 꺼짐', '오디오 소리 켜짐',
        '활동 보기', '활동보기',
        '인용하기', '이 게시물 공유',
        '스레드',
        '좋아요 표시', '저장됨', '보내기'
    ];

    const activityIndex = lines.findIndex(l => l.replace(/\s+/g, '').includes('활동보기'));
    if (activityIndex !== -1) lines = lines.slice(0, activityIndex);

    while (lines.length > 0 && (lines[0] === '스레드' || lines[0].startsWith('조회 '))) lines.shift();
    if (category) {
        while (lines.length > 0 && lines[0] === category) lines.shift();
    }

    // 작성자 및 시간 헤더 패턴 완벽 제거 (e.g. "studio.whynot 10시간", "studio.whynot", "10시간", "10시간 전")
    const authorTimePattern = /^@?[a-zA-Z0-9._]+(?:\s+(\d+(?:초|분|시간|일|주|h|m|d|s|w)(?:\s*전)?|\d+월\s*\d+일|\d+년\s*\d+월\s*\d+일|방금))?(?:\s*·\s*수정됨)?$/i;
    const standaloneTimePattern = /^(\d{4}[-./]\d{2}[-./]\d{2}|\d+(?:초|분|시간|일|주|h|m|d|s|w)(?:\s*전)?|\d+월\s*\d+일|\d+년\s*\d+월\s*\d+일|방금)(?:\s*·\s*수정됨)?$/i;

    let headerCleaned = true;
    while (lines.length > 0 && headerCleaned) {
        headerCleaned = false;
        const line = lines[0].trim();

        if (finalAuthor && finalAuthor !== 'Unknown' && (line === finalAuthor || line.startsWith(finalAuthor + ' ') || line.includes(finalAuthor))) {
            lines.shift();
            headerCleaned = true;
            continue;
        }
        if (authorTimePattern.test(line)) {
            lines.shift();
            headerCleaned = true;
            continue;
        }
        if (standaloneTimePattern.test(line) || (postDate && line === postDate) || (timeEl && line === timeEl.innerText.trim())) {
            lines.shift();
            headerCleaned = true;
            continue;
        }
        if (line === '팔로우' || line === 'Follow' || line === '팔로잉' || line === 'Following') {
            lines.shift();
            headerCleaned = true;
            continue;
        }
    }

    if (lines.length > 0 && lines[0].includes('님에게 답글 남기는 중')) lines.shift();

    const filteredLines = lines.filter(line => {
        const trimmed = line.trim();
        if (/^\d+\s*\/\s*\d+$/.test(trimmed)) return false;
        const numOnlyStr = trimmed.replace(/[,.만천KkMm\s]/g, '');
        if (!isNaN(numOnlyStr) && numOnlyStr !== '') return false;

        const normalized = trimmed.replace(/\s+/g, '');
        const cleanNum = normalized.replace(/[,.]/g, '');
        if (/^(?:꺼짐|켜짐)?좋아요\d+/.test(cleanNum) ||
            /^(?:꺼짐|켜짐)?답글\d+/.test(cleanNum) ||
            /^(?:꺼짐|켜짐)?리포스트\d+/.test(cleanNum) ||
            /^(?:꺼짐|켜짐)?공유하기\d+/.test(cleanNum) ||
            /^(?:꺼짐|켜짐)?조회\d+/.test(cleanNum) ||
            /^(?:꺼짐|켜짐)?조회수\d+/.test(cleanNum)) {
            return false;
        }

        if (/^좋아요\s*\d+/.test(trimmed) || /^\d+\s*개의?\s*(좋아요|답글|리포스트)/.test(trimmed)) return false;
        if (cleanNum.includes('좋아요') && cleanNum.includes('답글') && cleanNum.includes('공유하기')) return false;
        if (ignoreWords.includes(trimmed)) return false;
        if (trimmed.startsWith('아직 답글이 없습니다')) return false;
        if (/^\d+번째\s*(답글|타래)/.test(trimmed)) return false;
        if (/^(번역|원문)\s*(보기|평가하기|하기)/.test(trimmed)) return false;

        return true;
    });

    rawContent = filteredLines.join('\n').slice(0, 15000).trim();

    // ★ 텍스트가 비어있을 때의 강력한 다단계 Fallback (절대 빈 문자열로 백엔드 전송 실패하지 않음)
    if (!rawContent && mediaContainer.querySelectorAll) {
        const candidateSpans = Array.from(mediaContainer.querySelectorAll('span[dir="auto"], div[dir="auto"]'));
        const textPieces = candidateSpans
            .map(s => (s.innerText || '').trim())
            .filter(t => {
                if (!t || t.length < 2) return false;
                if (ignoreWords.includes(t)) return false;
                if (/^(?:좋아요|답글|리포스트|공유|조회|팔로우)/.test(t)) return false;
                if (finalAuthor && t === finalAuthor) return false;
                return true;
            });
        if (textPieces.length > 0) {
            rawContent = [...new Set(textPieces)].join('\n').slice(0, 15000);
        }
    }

    if (!rawContent) {
        const fallbackLines = rawInnerText
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !ignoreWords.includes(l) && !/^(?:좋아요|답글|리포스트|공유|조회)/.test(l));
        if (fallbackLines.length > 0) {
            rawContent = fallbackLines.join('\n').slice(0, 15000);
        }
    }

    if (!rawContent) {
        if (mediaItems && mediaItems.length > 0) {
            rawContent = '[미디어 게시물]';
        } else {
            rawContent = (mediaContainer.innerText || '').trim() || '(본문 내용 없음)';
        }
    }

    mainPostTextObj = { author: finalAuthor, category, postDate, text: rawContent };

    // 동영상 썸네일 비동기 추출 (필요한 경우만)
    for (const item of mediaItems) {
        if (item.type === 'video' && !item.thumbnail_base64 && item.url && item.url.startsWith('http') && item.url.includes('.mp4')) {
            try {
                const thumbDataUrl = await extractVideoThumbnail(item.url);
                if (thumbDataUrl) item.thumbnail_base64 = thumbDataUrl;
            } catch (err) { }
        }
    }

    // ★ 영상 수집 실패 판정: DOM 에는 <video> 가 있는데 최종 미디어에 사용 가능한 영상(http, 오디오 전용 아님)이 하나도 없으면
    //   조용히 이미지로 대체하지 않고 실패로 기록 → background 에서 스크랩 중단 + drt_error 리포트 + 사용자 안내
    let videoIssues = [];
    if (domVideos.length > 0) {
        const collectedVideoCount = mediaItems.filter(m =>
            m.type === 'video' && m.url && m.url.startsWith('http') && !isAudioUrl(m.url)
        ).length;
        if (collectedVideoCount === 0) {
            videoIssues = domUnresolvedVideos.length > 0
                ? domUnresolvedVideos.slice(0, 5)
                : [{ stage: 'DOM_VIDEO_URL_NOT_FOUND', url: '', reason: 'DOM <video> 는 있으나 최종 수집 결과에 영상이 없음' }];
        }
    }

    let url = window.location.href;

    // 피드/검색 결과 등에서 스크랩 시 해당 게시글의 다이렉트 URL로 교체
    if (extractedPostCode) {
        const host = window.location.hostname.includes('threads.com') ? 'www.threads.com' : 'www.threads.net';
        if (extractedAuthor && extractedAuthor !== 'Unknown') {
            url = `https://${host}/@${extractedAuthor}/post/${extractedPostCode}`;
        } else {
            url = `https://${host}/t/${extractedPostCode}`;
        }
    }

    // ? 뒤의 쿼리스트링(?xmt=... 등) 제거
    if (url && url.includes('?')) {
        url = url.split('?')[0];
    }

    // 혹시 extractedPostCode를 못 찾았고 url이 홈/검색창/피드 루트인 경우 한번 더 탐색
    if (url.endsWith('threads.com') || url.endsWith('threads.com/') || url.endsWith('threads.net') || url.endsWith('threads.net/') || url.includes('/search')) {
        const searchTarget = postRoot || mediaContainer;
        if (searchTarget.querySelectorAll) {
            const postLink = searchTarget.querySelector('a[href*="/post/"], a[href*="/t/"]');
            if (postLink) {
                const h = postLink.getAttribute('href') || '';
                const m = h.match(/\/@([^\/]+)\/post\/([^\/?#]+)/);
                if (m) {
                    extractedAuthor = extractedAuthor || m[1];
                    extractedPostCode = extractedPostCode || m[2];
                    url = `https://${window.location.hostname}/@${m[1]}/post/${m[2]}`;
                } else {
                    const tm = h.match(/\/t\/([^\/?#]+)/);
                    if (tm) {
                        extractedPostCode = extractedPostCode || tm[1];
                        url = `https://${window.location.hostname}/t/${tm[1]}`;
                    }
                }
            }
        }
    }

    // 작성자 최종 보정
    let author = extractedAuthor || finalAuthor || "Unknown";
    if (author === "Unknown" || author === "") {
        const pathParts = window.location.pathname.split('/');
        const userPart = pathParts.find(p => p.startsWith('@'));
        if (userPart) {
            author = userPart.replace('@', '');
        } else {
            const searchTarget = postRoot || mediaContainer;
            const mainAuthorEl = searchTarget.querySelector ? searchTarget.querySelector('a[href^="/@"]') : null;
            if (mainAuthorEl) {
                const h = mainAuthorEl.getAttribute('href') || '';
                const m = h.match(/^\/@([^\/?#]+)/);
                if (m) author = m[1];
            }
        }
    }
    if (author.startsWith('@')) author = author.substring(1);

    // 상단 드롭박스에서 현재 선택된 folder_id 추출
    const folderSelectEl = document.getElementById('dreaths-folder-dropdown');
    let chosenFolderId = null;
    let chosenFolderName = '미분류';
    if (folderSelectEl && folderSelectEl.value && folderSelectEl.value !== 'NONE') {
        chosenFolderId = Number(folderSelectEl.value);
        const selectedOpt = folderSelectEl.options[folderSelectEl.selectedIndex];
        if (selectedOpt) chosenFolderName = selectedOpt.text.replace('📁 ', '');
    }

    const payload = {
        original_url: url,
        raw_content: rawContent,
        original_author: author,
        category: mainPostTextObj ? mainPostTextObj.category : '',
        post_date: mainPostTextObj ? mainPostTextObj.postDate : '',
        media_items: mediaItems,
        likes: likes,
        comments: comments,
        reposts: reposts,
        shares: shares,
        views: views,
        folder_id: chosenFolderId,
        shortcode: extractedPostCode || undefined,
        video_issues: videoIssues.length > 0 ? videoIssues : undefined
    };

    try {
        chrome.runtime.sendMessage({ action: 'SCRAP_THREAD', payload: payload }, (response) => {
            if (chrome.runtime.lastError) {
                alert('에러: 확장프로그램이 업데이트되었습니다. 크롬 관리 페이지(chrome://extensions)에서 확장프로그램을 새로고침(Reload)하고 스레드 페이지도 새로고침(F5)해주세요.');
                return;
            }
            if (response && response.success) {
                if (response.today_count !== undefined) {
                    window.dreathsTodayCount = response.today_count;
                } else if (typeof window.dreathsTodayCount === 'number') {
                    window.dreathsTodayCount += 1;
                }
                updateScrapButtonCountUI();

                const limit = response.max_limit || window.dreathsDailyLimit || 100;
                const countMsg = window.dreathsTodayCount !== undefined 
                    ? ` (오늘 수집: ${window.dreathsTodayCount}/${limit})` 
                    : '';
                alert(`"${chosenFolderName}" 폴더에 성공적으로 스크랩되었습니다!${countMsg}`);
            } else {
                const errMsg = response ? response.error : '알 수 없는 오류';
                if (response?.code === 'DAILY_LIMIT_EXCEEDED' || (typeof errMsg === 'string' && errMsg.includes('한도'))) {
                    window.dreathsTodayCount = response?.today_count !== undefined ? response.today_count : 100;
                    updateScrapButtonCountUI();
                }
                alert('스크랩 실패: ' + errMsg);

                const isTokenIssue = response?.needToken || (typeof errMsg === 'string' && (errMsg.includes('JWT') || errMsg.includes('토큰') || errMsg.includes('인증')));
                if (isTokenIssue) {
                    try {
                        chrome.runtime.sendMessage({ action: 'OPEN_TAB', url: 'https://hongthreads.hongsik.blog/dashboard/benchmark' });
                    } catch (openErr) {
                        window.open('https://hongthreads.hongsik.blog/dashboard/benchmark', '_blank');
                    }
                }
            }
        });
    } catch (e) {
        alert('에러: 확장프로그램이 업데이트되었습니다. 크롬 관리 페이지(chrome://extensions)에서 확장프로그램을 새로고침(Reload)하고 스레드 페이지도 새로고침(F5)해주세요.\n(' + e.message + ')');
    }
}

// 즉시 및 주기적 버튼 재삽입 (SPA 대응)
injectScrapButton();
setInterval(injectScrapButton, 2000);

// ==========================================
// 4. DReaThs Analytics UI
// ==========================================
(function() {
    injectScrapButton();
    setInterval(injectScrapButton, 2000);

    // GraphQL interceptor 주입 (MAIN world)
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('interceptor.js');
    s.onload = function() { this.remove(); };
    (document.head || document.documentElement).appendChild(s);

    // ★ GraphQL / Fiber 미디어 및 데이터 수신
    window.addEventListener('message', function(event) {
        if (event.source !== window || !event.data) return;

        if (!window.DReaThsStats.media) window.DReaThsStats.media = {};
        if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};

        // 미디어 데이터 전용 수신 (품질 점수 비교 병합으로 단일 이미지 썸네일 덮어쓰기 방지)
        if (event.data.type === 'DREATHS_MEDIA_DATA') {
            if (event.data.media) {
                for (const [code, items] of Object.entries(event.data.media)) {
                    if (Array.isArray(items) && items.length > 0) {
                        mergeMediaStatsCache(code, items);
                    }
                }
            }
        }

        if (event.data.type === 'DREATHS_GRAPHQL_INTERCEPT') {
            try {
                const visited = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
                const extractData = (obj, depth) => {
                    if (!obj || typeof obj !== 'object' || depth > 150) return;
                    if (visited) {
                        if (visited.has(obj)) return;
                        visited.add(obj);
                    }
                    if (Array.isArray(obj)) { obj.forEach(item => extractData(item, depth + 1)); return; }

                    // 팔로워 추출
                    if (obj.username && typeof obj.username === 'string') {
                        if (obj.follower_count !== undefined) window.DReaThsStats.followers[obj.username] = parseInt(obj.follower_count);
                        if (obj.friendship_status && obj.friendship_status.follower_count !== undefined)
                            window.DReaThsStats.followers[obj.username] = parseInt(obj.friendship_status.follower_count);
                    }

                    // 게시글 데이터 및 미디어 추출
                    const postCode = obj.code || obj.shortcode || obj.post_code;
                    if (postCode && typeof postCode === 'string' && postCode.length > 3) {
                        const mItems = parsePostMedia(obj);
                        if (mItems.length > 0) {
                            mergeMediaStatsCache(postCode, mItems);
                        }

                        const pd = window.DReaThsStats.posts[postCode] || {};
                        if (obj.like_count !== undefined) pd.likes = parseInt(obj.like_count);
                        if (obj.view_count !== undefined) { pd.views = parseInt(obj.view_count); window.DReaThsStats.views[postCode] = pd.views; }
                        if (obj.comment_count !== undefined) pd.replies = parseInt(obj.comment_count);
                        if (obj.share_count !== undefined) pd.shares = parseInt(obj.share_count);
                        if (obj.taken_at !== undefined) pd.taken_at = parseInt(obj.taken_at);

                        const tpai = obj.text_post_app_info;
                        if (tpai) {
                            if (tpai.direct_reply_count !== undefined) pd.replies = parseInt(tpai.direct_reply_count);
                            if (tpai.view_count !== undefined) { pd.views = parseInt(tpai.view_count); window.DReaThsStats.views[postCode] = pd.views; }
                            if (tpai.share_count !== undefined) pd.shares = parseInt(tpai.share_count);
                            if (tpai.share_info) {
                                if (tpai.share_info.repost_count !== undefined) pd.reposts = parseInt(tpai.share_info.repost_count);
                                if (tpai.share_info.quote_count !== undefined) pd.quotes = parseInt(tpai.share_info.quote_count);
                                if (tpai.share_info.share_count !== undefined) pd.shares = parseInt(tpai.share_info.share_count);
                            }
                        }
                        if (obj.user && obj.user.username) {
                            pd.author = obj.user.username;
                            if (obj.user.follower_count !== undefined) {
                                window.DReaThsStats.followers[obj.user.username] = parseInt(obj.user.follower_count);
                                pd.authorFollowers = parseInt(obj.user.follower_count);
                            }
                        }
                        window.DReaThsStats.posts[postCode] = pd;
                    }

                    // 재귀적 탐색
                    if (obj.post && typeof obj.post === 'object' && !Array.isArray(obj.post)) extractData(obj.post, depth + 1);
                    for (const key of Object.keys(obj)) {
                        if (key === 'post') continue;
                        const val = obj[key];
                        if (val && typeof val === 'object') extractData(val, depth + 1);
                    }
                };
                extractData(event.data.data, 0);
            } catch(e) {}
        }

        // ★ Fiber 스캐너 결과 수신
        if (event.data.type === 'DREATHS_FIBER_DATA') {
            try {
                const r = event.data;
                if (r.media) {
                    for (const [code, items] of Object.entries(r.media)) {
                        if (Array.isArray(items) && items.length > 0) {
                            mergeMediaStatsCache(code, items);
                        }
                    }
                }
                if (r.posts) {
                    for (const [code, pd] of Object.entries(r.posts)) {
                        window.DReaThsStats.posts[code] = { ...(window.DReaThsStats.posts[code] || {}), ...pd };
                    }
                }
                if (r.views) {
                    for (const [code, v] of Object.entries(r.views)) {
                        window.DReaThsStats.views[code] = v;
                    }
                }
                if (r.followers) {
                    for (const [user, fc] of Object.entries(r.followers)) {
                        window.DReaThsStats.followers[user] = fc;
                    }
                }
            } catch(e) {}
        }
    });

    // ★ 스크립트 태그 스캔 (초기 + 5초마다)
    const scanScriptTags = () => {
        try {
            if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
            if (!window.DReaThsStats.media) window.DReaThsStats.media = {};
            document.querySelectorAll('script[type="application/json"], script:not([src])').forEach(script => {
                const html = script.innerHTML;
                if (!html || html.length < 50) return;
                if (!html.includes('follower_count') && !html.includes('view_count') && !html.includes('like_count') && !html.includes('video_versions') && !html.includes('videoVersions') && !html.includes('carousel_media') && !html.includes('image_versions2')) return;
                for (const m of html.matchAll(/"username"\s*:\s*"([^"]+)"[^]*?"follower_count"\s*:\s*(\d+)/g)) {
                    if (m[1] && m[2] && m[0].length < 5000) window.DReaThsStats.followers[m[1]] = parseInt(m[2]);
                }
                for (const m of html.matchAll(/"follower_count"\s*:\s*(\d+)[^]*?"username"\s*:\s*"([^"]+)"/g)) {
                    if (m[1] && m[2] && m[0].length < 5000) window.DReaThsStats.followers[m[2]] = parseInt(m[1]);
                }
                for (const m of html.matchAll(/"code"\s*:\s*"([^"]+)"[^]*?"view_count"\s*:\s*(\d+)/g)) {
                    if (m[1] && m[2] && m[0].length < 5000) window.DReaThsStats.views[m[1]] = parseInt(m[2]);
                }
                for (const m of html.matchAll(/"view_count"\s*:\s*(\d+)[^]*?"code"\s*:\s*"([^"]+)"/g)) {
                    if (m[1] && m[2] && m[0].length < 5000) window.DReaThsStats.views[m[2]] = parseInt(m[1]);
                }

                // ★ JSON 트리 정밀 파싱으로 포스트별 미디어 추출 (인접 게시글 침범하는 문자열 슬라이스 제거)
                try {
                    const parsed = JSON.parse(html);
                    findPostMediaInJsonTree(parsed, null);
                } catch(eJson) {}
            });
        } catch(e) {}
    };
    scanScriptTags();
    setInterval(scanScriptTags, 5000);

    // React Fiber 스캔은 interceptor.js (MAIN world)에서 실행됨
    // 결과는 DREATHS_FIBER_DATA 메시지로 수신

    // ==========================================
    // ★ 초고속 병렬 데이터 수확 엔진 (High-Speed Concurrent Harvester)
    // ==========================================
    const fetchedProfiles = new Set();
    const fetchedCodes = new Set();
    const harvesterQueue = []; // { type: 'profile'|'post', key: string, highPriority: boolean }
    const MAX_CONCURRENT_WORKERS = 4;
    let activeWorkers = 0;

    // 세션 스토리지 캐시 로드 (새로고침/이동 시 0ms 즉각 복원)
    try {
        const cached = JSON.parse(sessionStorage.getItem('dreaths_stats_cache') || '{}');
        if (cached.followers) Object.assign(window.DReaThsStats.followers, cached.followers);
        if (cached.views) Object.assign(window.DReaThsStats.views, cached.views);
        if (cached.profiles) Object.assign(window.DReaThsStats.profiles, cached.profiles);
    } catch(e) {}

    let cacheSaveTimer = null;
    const persistStatsCache = () => {
        if (cacheSaveTimer) return;
        cacheSaveTimer = setTimeout(() => {
            cacheSaveTimer = null;
            try {
                sessionStorage.setItem('dreaths_stats_cache', JSON.stringify({
                    followers: window.DReaThsStats.followers,
                    views: window.DReaThsStats.views,
                    profiles: window.DReaThsStats.profiles
                }));
            } catch(e) {}
        }, 1000);
    };

    const queueTarget = (item) => {
        if (!item || !item.key) return;
        if (item.type === 'profile') {
            if (window.DReaThsStats.followers[item.key] !== undefined || fetchedProfiles.has(item.key)) return;
            if (harvesterQueue.some(q => q.type === 'profile' && q.key === item.key)) return;
            if (item.highPriority) harvesterQueue.unshift(item);
            else harvesterQueue.push(item);
        } else if (item.type === 'post') {
            if (window.DReaThsStats.views[item.key] !== undefined || fetchedCodes.has(item.key)) return;
            if (harvesterQueue.some(q => q.type === 'post' && q.key === item.key)) return;
            if (item.highPriority) harvesterQueue.unshift(item);
            else harvesterQueue.push(item);
        }
        triggerWorkers();
    };

    const triggerWorkers = () => {
        while (activeWorkers < MAX_CONCURRENT_WORKERS && harvesterQueue.length > 0) {
            const nextItem = harvesterQueue.shift();
            if (!nextItem) break;
            activeWorkers++;
            runWorker(nextItem);
        }
    };

    let pulseStyle = document.getElementById('dreaths-pulse-style');
    if (!pulseStyle) {
        pulseStyle = document.createElement('style');
        pulseStyle.id = 'dreaths-pulse-style';
        document.head.appendChild(pulseStyle);
    }
    pulseStyle.innerHTML = `
        @keyframes dreaths-pulse-glow {
            0% { transform: scale(0.9); opacity: 0.6; }
            50% { transform: scale(1.25); opacity: 1; box-shadow: 0 0 8px rgba(245, 158, 11, 0.8); }
            100% { transform: scale(0.9); opacity: 0.6; }
        }
        .dreaths-pulse-dot {
            animation: dreaths-pulse-glow 1.2s infinite ease-in-out;
        }
        .dreaths-chart-bar-wrap {
            transition: transform 0.15s ease;
        }
        .dreaths-chart-bar-wrap:hover .dreaths-bar-label {
            opacity: 1 !important;
            transform: scale(1.12);
            font-weight: 800 !important;
        }
        .dreaths-chart-bar-wrap:hover .dreaths-bar-inner {
            filter: brightness(1.3) saturate(1.2) !important;
        }
        .dreaths-breakout-item:hover {
            background: rgba(225, 29, 72, 0.08) !important;
            border-color: rgba(225, 29, 72, 0.45) !important;
            transform: translateY(-1px);
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
        }
    `;

    let profileFetchInFlight = new Set();

    const fetchProfileData = async (username) => {
        if (!username || profileFetchInFlight.has(username)) return;
        profileFetchInFlight.add(username);
        try {
            if (!window.DReaThsStats.profiles) window.DReaThsStats.profiles = {};
            if (!window.DReaThsStats.profiles[username]) {
                window.DReaThsStats.profiles[username] = { followers: null, viewsList: [], postCodes: [], isAnalyzing: true };
            }
            const prof = window.DReaThsStats.profiles[username];
            prof.isAnalyzing = true;
            if (typeof renderProfileDashboard === 'function') renderProfileDashboard();

            const url = `${location.origin}/@${username}`;
            const resp = await fetch(url, {
                credentials: 'include',
                headers: { 'Accept': 'text/html' }
            });
            if (!resp.ok) {
                prof.isAnalyzing = false;
                if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
                return;
            }
            const html = await resp.text();

            // 1. 팔로워 수 추출
            let fc = null;
            const fcRegex = new RegExp(`"username"\\s*:\\s*"${username}"[^]*?"follower_count"\\s*:\\s*(\\d+)`);
            const fcMatch = html.match(fcRegex) || html.match(/"follower_count"\\s*:\\s*(\\d+)/);
            if (fcMatch && fcMatch[1]) {
                fc = parseInt(fcMatch[1], 10);
                window.DReaThsStats.followers[username] = fc;
                prof.followers = fc;
            }

            // 2. 최근 게시물들의 shortcode 및 조회수, 반응, 본문 메타데이터 일괄 추출
            // ★ 타인/추천 게시글 혼입 원천 차단 (작성자 username 엄격 검증)
            const extractedItems = [];
            const seenCodes = new Set();

            const processMatchedItem = (code, views, fullMatch, matchIndex) => {
                if (!code || views <= 0 || seenCodes.has(code)) return;

                // 1) 캐시된 포스트 작성자 확인
                const cachedPost = window.DReaThsStats.posts && window.DReaThsStats.posts[code];
                if (cachedPost && cachedPost.author && cachedPost.author.toLowerCase() !== username.toLowerCase()) {
                    return; // 다른 사용자의 글이 확실하므로 스킵!
                }

                // 2) HTML 컨텍스트(앞뒤 2000자)에서 포스트 작성자 확인
                const start = Math.max(0, matchIndex - 2000);
                const end = Math.min(html.length, matchIndex + fullMatch.length + 2000);
                const chunk = html.substring(start, end);

                // JSON 상의 작성자 필드 검사
                const authorMatch = chunk.match(/"user"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"/) ||
                                    chunk.match(/"owner"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"/) ||
                                    chunk.match(/"author"\s*:\s*\{[^}]*?"username"\s*:\s*"([^"]+)"/);
                if (authorMatch && authorMatch[1]) {
                    const postAuthor = authorMatch[1].toLowerCase();
                    if (postAuthor !== username.toLowerCase()) {
                        return; // 타 사용자(추천/트렌딩 게시물) 스킵!
                    }
                } else {
                    // 작성자 필드가 명시되지 않은 경우, 청크 내에 대상 유저명("${username}")이 없으면 추천 글이므로 스킵!
                    if (!chunk.toLowerCase().includes(`"${username.toLowerCase()}"`)) {
                        return;
                    }
                }

                seenCodes.add(code);
                let likes = 0, replies = 0, taken_at = null, text = '', mediaType = '텍스트 전용';
                const lMatch = fullMatch.match(/"like_count"\s*:\s*(\d+)/);
                if (lMatch) likes = parseInt(lMatch[1], 10);
                const rMatch = fullMatch.match(/"(?:comment_count|direct_reply_count)"\s*:\s*(\d+)/);
                if (rMatch) replies = parseInt(rMatch[1], 10);
                const tMatch = fullMatch.match(/"taken_at"\s*:\s*(\d+)/);
                if (tMatch) taken_at = parseInt(tMatch[1], 10);
                const capMatch = fullMatch.match(/"caption"\s*:\s*\{[^}]*?"text"\s*:\s*"((?:\\.|[^"\\])*)"/) || fullMatch.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
                if (capMatch) {
                    try { text = JSON.parse(`"${capMatch[1]}"`); } catch(e) { text = capMatch[1]; }
                }
                if (fullMatch.includes('"video_versions"') && !fullMatch.includes('"video_versions":[]')) mediaType = '동영상';
                else if (fullMatch.includes('"carousel_media"')) mediaType = '캐러셀';
                else if (fullMatch.includes('"image_versions2"')) mediaType = '단일 이미지';

                extractedItems.push({ code, views, likes, replies, taken_at, text, mediaType });
            };

            for (const m of html.matchAll(/"code"\s*:\s*"([^"]+)"[^]*?"view_count"\s*:\s*(\d+)/g)) {
                if (m[1] && m[2] && m[0].length < 5000) {
                    processMatchedItem(m[1], parseInt(m[2], 10), m[0], m.index);
                }
            }
            for (const m of html.matchAll(/"view_count"\s*:\s*(\d+)[^]*?"code"\s*:\s*"([^"]+)"/g)) {
                if (m[1] && m[2] && m[0].length < 5000) {
                    processMatchedItem(m[2], parseInt(m[1], 10), m[0], m.index);
                }
            }

            // 3. 실시간 분석 진행 표시를 위한 프로그레시브 스트림 (사용자 피드백 반영)
            if (extractedItems.length > 0) {
                prof.totalTargetCount = extractedItems.length;
                prof.viewsList = [];
                prof.postCodes = [];
                let currentIdx = 0;

                const processNext = () => {
                    const activeProfile = typeof getProfileUsername === 'function' ? getProfileUsername() : null;
                    if (activeProfile !== username) {
                        // 페이지를 벗어났을 경우 즉시 전체 데이터 반영 후 완료
                        for (let i = currentIdx; i < extractedItems.length; i++) {
                            const it = extractedItems[i];
                            window.DReaThsStats.views[it.code] = it.views;
                            if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                            const pd = window.DReaThsStats.posts[it.code] || {};
                            pd.views = it.views;
                            if (it.likes) pd.likes = it.likes;
                            if (it.replies) pd.replies = it.replies;
                            if (it.taken_at) pd.taken_at = it.taken_at;
                            if (it.text) pd.text = it.text;
                            if (it.mediaType) pd.mediaType = it.mediaType;
                            window.DReaThsStats.posts[it.code] = pd;

                            if (!prof.postCodes.includes(it.code)) {
                                prof.postCodes.push(it.code);
                                prof.viewsList.push(it.views);
                            }
                        }
                        prof.isAnalyzing = false;
                        persistStatsCache();
                        return;
                    }

                    if (currentIdx < extractedItems.length) {
                        const it = extractedItems[currentIdx];
                        window.DReaThsStats.views[it.code] = it.views;
                        if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                        const pd = window.DReaThsStats.posts[it.code] || {};
                        pd.views = it.views;
                        if (it.likes) pd.likes = it.likes;
                        if (it.replies) pd.replies = it.replies;
                        if (it.taken_at) pd.taken_at = it.taken_at;
                        if (it.text) pd.text = it.text;
                        if (it.mediaType) pd.mediaType = it.mediaType;
                        pd.author = username;
                        if (fc) pd.authorFollowers = fc;
                        window.DReaThsStats.posts[it.code] = pd;

                        if (!prof.postCodes.includes(it.code)) {
                            prof.postCodes.push(it.code);
                            prof.viewsList.push(it.views);
                        }
                        currentIdx++;
                        if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
                        if (typeof injectAnalyticsUI === 'function') injectAnalyticsUI();
                        setTimeout(processNext, 110);
                    } else {
                        prof.isAnalyzing = false;
                        if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
                        if (typeof injectAnalyticsUI === 'function') injectAnalyticsUI();
                        persistStatsCache();
                    }
                };
                processNext();
            } else {
                prof.isAnalyzing = false;
                if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
            }

            console.log(`[DReaThs Profile] ✅ @${username} (팔로워: ${fc !== null ? fc.toLocaleString() + '명' : 'N/A'}, 추출 게시물: ${extractedItems.length}건)`);
        } catch(e) {
            const currentProfileUser = typeof getProfileUsername === 'function' ? getProfileUsername() : null;
            if (currentProfileUser === username) {
                console.warn(`[DReaThs Profile] @${username} fetch failed:`, e);
            }
            if (window.DReaThsStats.profiles && window.DReaThsStats.profiles[username]) {
                window.DReaThsStats.profiles[username].isAnalyzing = false;
                if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
            }
        } finally {
            profileFetchInFlight.delete(username);
        }
    };

    const fetchViewCount = async (postCode) => {
        if (!postCode) return;
        try {
            const url = `${location.origin}/t/${postCode}`;
            const resp = await fetch(url, {
                credentials: 'include',
                headers: { 'Accept': 'text/html' }
            });
            if (!resp.ok) return;
            const html = await resp.text();

            // ★ 상세 페이지 HTML SSR 데이터에서 해당 게시글의 원본 미디어(동영상/캐러셀)도 함께 사전 캐싱!
            try {
                extractMediaFromPostDetailHtml(html, postCode);
            } catch (mErr) {}

            const applyViews = (views) => {
                window.DReaThsStats.views[postCode] = views;
                if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                const pd = window.DReaThsStats.posts[postCode] || {};
                pd.views = views;
                window.DReaThsStats.posts[postCode] = pd;

                const currUser = typeof getProfileUsername === 'function' ? getProfileUsername() : null;
                if (currUser && window.DReaThsStats.profiles && window.DReaThsStats.profiles[currUser]) {
                    const p = window.DReaThsStats.profiles[currUser];
                    // ★ 해당 게시물의 작성자가 현재 프로필 유저(currUser)인 경우에만 통계에 포함
                    const postAuthor = pd.author ? pd.author.toLowerCase() : null;
                    if (postAuthor && postAuthor !== currUser.toLowerCase()) {
                        return; // 타 사용자의 게시물이면 프로필 통계에 절대 혼입시키지 않음!
                    }
                    if (!p.postCodes.includes(postCode)) {
                        p.postCodes.push(postCode);
                        p.viewsList.push(views);
                        if (typeof renderProfileDashboard === 'function') renderProfileDashboard();
                    }
                }
            };

            // 방법 1: JSON 데이터에서 view_count 추출
            const jsonViewMatch = html.match(/"view_count"\s*:\s*(\d+)/);
            if (jsonViewMatch && parseInt(jsonViewMatch[1]) > 0) {
                applyViews(parseInt(jsonViewMatch[1]));
                return;
            }

            // 방법 2: "조회 N만회" 텍스트에서 추출
            const textViewMatch = html.match(/조회\s+([\d,.]+)(만|천|[KkMm])?\s*회/);
            if (textViewMatch) {
                let num = parseFloat(textViewMatch[1].replace(/,/g, ''));
                const unit = textViewMatch[2] || '';
                if (unit === '만') num *= 10000;
                else if (unit === '천' || unit === 'K' || unit === 'k') num *= 1000;
                else if (unit === 'M' || unit === 'm') num *= 1000000;
                if (num > 0) {
                    applyViews(Math.round(num));
                    return;
                }
            }
        } catch(e) {}
    };

    const runWorker = async (item) => {
        try {
            if (item.type === 'profile') {
                fetchedProfiles.add(item.key);
                await fetchProfileData(item.key);
            } else if (item.type === 'post') {
                fetchedCodes.add(item.key);
                await fetchViewCount(item.key);
            }
        } catch(e) {
        } finally {
            activeWorkers--;
            persistStatsCache();
            if (harvesterQueue.length > 0) {
                setTimeout(triggerWorkers, 40);
            }
        }
    };

    const scanAllTargets = () => {
        try {
            const authorLinks = document.querySelectorAll('a[href^="/@"]');
            authorLinks.forEach(link => {
                const href = link.getAttribute('href');
                if (!href) return;
                const username = href.replace(/^\//, '').replace(/^@/, '').replace(/\/$/, '');
                if (!username || username.includes('/')) return;
                queueTarget({ type: 'profile', key: username, highPriority: false });
            });

            const postLinks = document.querySelectorAll('a[href*="/post/"], a[href*="/t/"]');
            postLinks.forEach(link => {
                const href = link.getAttribute('href');
                const m = href.match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/);
                if (m && m[1]) {
                    queueTarget({ type: 'post', key: m[1], highPriority: false });
                }
            });
        } catch(e) {}
    };

    // 즉시 및 주기적 스캔 시작
    setTimeout(scanAllTargets, 100);
    setTimeout(scanAllTargets, 800);
    setInterval(scanAllTargets, 3000);

    // 스크롤 시 화면 내 신규 게시글 즉각 반응도 스캔
    let scrollScanTimer = null;
    window.addEventListener('scroll', () => {
        if (scrollScanTimer) return;
        scrollScanTimer = setTimeout(() => {
            scrollScanTimer = null;
            injectAnalyticsUI();
        }, 100);
    }, { passive: true });

    // ★ 디버그 로깅 (5초마다 현재 수집 상태 출력)
    setInterval(() => {
        const fc = Object.keys(window.DReaThsStats.followers).length;
        const vc = Object.keys(window.DReaThsStats.views).length;
        const pc = window.DReaThsStats.posts ? Object.keys(window.DReaThsStats.posts).length : 0;
        if (fc > 0 || vc > 0 || pc > 0) {
            console.log(`[DReaThs] 수집 현황: 팔로워 ${fc}명, 조회수 ${vc}건, 게시글 ${pc}건`);
        }
    }, 5000);

    // 숫자 파서 (혼합 텍스트에서 숫자 추출 가능)
    const parseFormattedNumber = (text) => {
        if (!text) return 0;
        // 먼저 텍스트에서 숫자 부분만 추출 (예: "좋아요1.5천" → "1.5천")
        const numMatch = text.match(/([0-9][0-9,.]*)\s*([KkMm만천])?/);
        if (!numMatch) return 0;
        let numStr = numMatch[1].replace(/,/g, '');
        let multi = 1;
        const suffix = numMatch[2] || '';
        if (suffix === 'K' || suffix === 'k') multi = 1000;
        else if (suffix === 'M' || suffix === 'm') multi = 1000000;
        else if (suffix === '만') multi = 10000;
        else if (suffix === '천') multi = 1000;
        return (parseFloat(numStr) || 0) * multi;
    };

    // SVG에서 숫자를 찾는 범용 함수 (버튼 컨테이너 및 주변 텍스트 스캔)
    const findNumberForSvg = (svg) => {
        if (!svg) return 0;

        // 1. svg 자체의 aria-label, title 속성 또는 <title> 태그에서 숫자 검사 (예: "좋아요 117개")
        const svgAria = svg.getAttribute('aria-label') || svg.getAttribute('title') || svg.querySelector('title')?.textContent || '';
        const svgAriaNum = parseFormattedNumber(svgAria);
        if (svgAriaNum > 0) return svgAriaNum;

        const btn = svg.closest('button, [role="button"]');
        if (btn) {
            const btnAria = btn.getAttribute('aria-label') || btn.getAttribute('title') || '';
            const btnAriaNum = parseFormattedNumber(btnAria);
            if (btnAriaNum > 0) return btnAriaNum;

            // 2. btn의 직후 형제(nextElementSibling)에 카운트가 있는 경우
            if (btn.nextElementSibling) {
                const sibText = btn.nextElementSibling.textContent.trim();
                if (/\d/.test(sibText) && sibText.length < 15) {
                    const n = parseFormattedNumber(sibText);
                    if (n > 0) return n;
                }
            }
        }

        // 3. 버튼과 카운트가 함께 속한 아이템 컨테이너에서 숫자 찾기
        const searchRoot = (btn && btn.parentElement) ? btn.parentElement : (svg.parentElement ? svg.parentElement.parentElement : null) || svg.parentElement;
        if (!searchRoot) return 0;

        // 전략 1: searchRoot 내의 모든 span/div에서 숫자 찾기
        const spans = searchRoot.querySelectorAll('span, div');
        for (const span of spans) {
            const t = span.textContent.trim();
            if (/^\s*[\d,.]+(?:만|천|[KkMm])?\s*$/.test(t)) {
                const n = parseFormattedNumber(t);
                if (n > 0) return n;
            }
        }

        // 전략 2: 직접 자식 텍스트 노드에서 찾기
        for (const child of searchRoot.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                const t = child.textContent.trim();
                if (/\d/.test(t) && t.length < 15) {
                    const n = parseFormattedNumber(t);
                    if (n > 0) return n;
                }
            }
        }

        // 전략 3: 부모를 올라가며 숫자 단독 텍스트 찾기
        let curr = svg.parentElement;
        for (let depth = 0; depth < 5 && curr && curr !== document.body; depth++) {
            const t = curr.textContent.trim();
            if (/^[\d,.]+(?:만|천|[KkMm])?$/.test(t)) {
                const n = parseFormattedNumber(t);
                if (n > 0) return n;
            }
            curr = curr.parentElement;
        }
        return 0;
    };

    // ★ 확장프로그램 공식 반응도 지표 점수(pt) 계산 엔진 (단일 진실 공급원 - Single Source of Truth)
    const calcReactionScore = (params) => {
        const { views = 0, likes = 0, replies = 0, reposts = 0, shares = 0, followers = 0, timeHours = 24 } = params;
        const weightedScore = (likes * 2) + (replies * 3) + (shares * 3) + (reposts * 4);
        const totalEngagement = likes + replies + reposts + shares;
        
        // 시간 감쇠: 게시물 성숙 기간(최대 48시간)을 기준으로 적용하여 과거 터진 게시글의 반응도 점수가 1pt로 비정상 소멸하는 것 방지
        const effectiveTimeHours = Math.min(Math.max(timeHours, 1), 48);
        const softTimeFactor = Math.max(0.45, Math.sqrt(12 / (effectiveTimeHours + 11)));

        if (views > 0) {
            const reactionRate = (weightedScore / views * 100);
            // 인터랙션이 아직 0이거나 미수집된 경우, 조회수 기반 추정 인터랙션(views * 0.04)을 Fallback 베이스로 적용
            const baseScore = Math.pow(weightedScore > 0 ? weightedScore : (views * 0.04), 0.75) * 3;
            let bonus = 0;
            if (followers > 0) {
                // ★ 통계적 분모 왜곡 방지 (Follower Floor):
                // 팔로워 수가 1~50명 수준인 극소수 계정의 경우, 단순 50~100회 노출 테스트만으로도 배수가 수십 배로 왜곡되어
                // 91 조회수 글이 301pt로 폭증하는 버그를 방지하기 위해 최소 분모 기준을 100명으로 보정
                const effectiveFollowers = Math.max(followers, 100);
                const spreadRatio = views / effectiveFollowers;
                if (spreadRatio > 1) {
                    let spreadBonus = Math.log2(spreadRatio) * 30;
                    if (spreadRatio >= 100) {
                        spreadBonus += 350 + Math.min((spreadRatio - 100) * 1.5, 350);
                    } else if (spreadRatio >= 30) {
                        spreadBonus += 180 + ((spreadRatio - 30) / 70) * 170;
                    } else if (spreadRatio >= 10) {
                        spreadBonus += 70 + ((spreadRatio - 10) / 20) * 110;
                    } else if (spreadRatio >= 3) {
                        spreadBonus += 20 + ((spreadRatio - 3) / 7) * 50;
                    }

                    // ★ 절대 조회수 신뢰도 가중치 (Scale Confidence):
                    // 1,000회 미만 초기 탐색 단계에서는 아직 진정한 플랫폼 바이럴로 검증되지 않았으므로 확산 보너스를 점진적으로 적용
                    let scaleConfidence = 1.0;
                    if (views < 1000) {
                        scaleConfidence = Math.max(0, (views - 100) / 900);
                    }
                    bonus += spreadBonus * scaleConfidence;
                }
            }
            if (reactionRate > 2.0 && views >= 100) {
                const rateConfidence = Math.min(1, views / 500);
                bonus += Math.min(reactionRate * 5, 80) * rateConfidence;
            }
            const score = Math.floor((baseScore + bonus) * softTimeFactor);
            return Math.max(score, 1);
        } else if (weightedScore > 0) {
            const baseScore = Math.pow(weightedScore, 0.75) * 3;
            let bonus = 0;
            if (followers > 0) {
                const effectiveFollowers = Math.max(followers, 100);
                const followerRatio = totalEngagement / effectiveFollowers;
                const spreadRatio = (totalEngagement * 10) / effectiveFollowers;
                if (followerRatio > 0.05) bonus += Math.min(followerRatio * 350, 150);
                if (spreadRatio >= 30) bonus += 180;
                else if (spreadRatio >= 10) bonus += 70;
            }
            const score = Math.floor((baseScore + bonus) * softTimeFactor);
            return Math.max(score, 1);
        }
        return 1;
    };

    // ==========================================
    // ★ 메타(Meta) 공식 알고리즘 분석 헬퍼 & 2차 상세 분석(On-Demand) 엔진
    // ==========================================
    window.DReaThsStats.deepAnalysis = window.DReaThsStats.deepAnalysis || {};

    // [슬라이드 #6] 알고리즘이 평가하지 않는 콘텐츠(인게이지먼트 베이트 / 저품질 바이럴 / 선동) 감지
    const detectEngagementBait = (text) => {
        if (!text || typeof text !== 'string') {
            return { isBait: false, matchedKeywords: [], riskLevel: '클린', penaltyFactor: 1.0 };
        }
        const normalized = text.toLowerCase();
        const baitPatterns = [
            { label: '팔로우 유도', regex: /(팔로우\s*해\s*주|팔로우해주|맞팔|선팔|팔로우\s*하시고|팔로우\s*부탁)/i },
            { label: '아이디/댓글 유도', regex: /(아이디\s*알려|아이디\s*남겨|댓글로?\s*남겨\s*주|댓글\s*달아\s*주|댓글에\s*['"][^'"]+['"])/i },
            { label: '하트/공유 강요', regex: /(하트\s*누르고|좋아요\s*누르고|공유해\s*주시면|리포스트\s*해주시면|저장해\s*두시고)/i },
            { label: '자극/어그로 프레이밍', regex: /(충격\s*실화|안\s*보면\s*평생\s*손해|무조건\s*저장하세요|이거\s*모르면\s*호구)/i }
        ];
        const matchedKeywords = [];
        baitPatterns.forEach(p => {
            if (p.regex.test(normalized)) {
                matchedKeywords.push(p.label);
            }
        });
        if (matchedKeywords.length >= 2) {
            return { isBait: true, matchedKeywords, riskLevel: '페널티 위험', penaltyFactor: 0.78 };
        } else if (matchedKeywords.length === 1) {
            return { isBait: true, matchedKeywords, riskLevel: '베이트 주의', penaltyFactor: 0.88 };
        }
        return { isBait: false, matchedKeywords: [], riskLevel: '클린', penaltyFactor: 1.0 };
    };

    // [슬라이드 #3, #4, #8 Action 1] 도입부 후킹(Hook) & 체류시간(Dwell Time) & 스크롤 스킵 방어력 분석
    const analyzeHookAndDwell = (text, mediaType = '텍스트 전용', hasExternalLink = false) => {
        const cleanText = (text || '').trim();
        const lines = cleanText ? cleanText.split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [];
        const firstLine = lines[0] || '';
        const charCount = cleanText.length;
        const lineCount = lines.length;

        // 도입부 첫 줄 후킹 유형 분석
        const hookTypes = [];
        if (/[?？]|왜\s|어떻게|비결|이유|방법|진짜\s|과연/.test(firstLine)) hookTypes.push('호기심/질문형');
        if (/\d+\s*(?:가지|개|%|배|만|억|년|일|분|초|위|단계|원)/.test(firstLine)) hookTypes.push('숫자/데이터형');
        if (/^[\[【(「『🔥💡🚨📌⚡❗]/.test(firstLine)) hookTypes.push('시각강조/괄호형');
        if (/(솔직히|사실은?|요즘|오늘\s|제가\s|나만\s|결국)/.test(firstLine)) hookTypes.push('공감/스토리형');
        if (hookTypes.length === 0 && firstLine.length > 0) hookTypes.push('일반 서술형');

        // 예상 체류시간(초) 산출: 글자수 읽기 시간 + 줄바꿈 호흡 + 미디어 탐색 시간 + 고유 링크 체류
        // 한국어 평균 독서 속도(초당 약 14자) + 기본 스캔 시간 2.5초
        let estDwellSec = 2.5 + (charCount / 14) + Math.min(lineCount * 0.6, 8);
        let tapExploreBonus = 0; // 슬라이드 #3 02(게시물 탭) & 03(탭하여 다른 게시물 보기)

        if (mediaType.includes('캐러셀')) {
            estDwellSec += 9.5; // 슬라이드 넘기기(Tap to explore more) 체류 효과 극대화
            tapExploreBonus += 35;
        } else if (mediaType.includes('동영상')) {
            estDwellSec += 11.0;
            tapExploreBonus += 30;
        } else if (mediaType.includes('이미지')) {
            estDwellSec += 4.5;
            tapExploreBonus += 15;
        }

        // 장문(더보기 탭 유도) 여부
        const triggersReadMoreTap = charCount >= 160 || lineCount >= 6;
        if (triggersReadMoreTap) {
            estDwellSec += 5.0;
            tapExploreBonus += 25;
        }

        // 슬라이드 #4: 고유 링크 조회 시간 시그널
        if (hasExternalLink) {
            estDwellSec += 6.5;
            tapExploreBonus += 15;
        }

        estDwellSec = Math.round(Math.min(Math.max(estDwellSec, 3), 90));

        let dwellGrade = 'C';
        if (estDwellSec >= 22) dwellGrade = 'S';
        else if (estDwellSec >= 14) dwellGrade = 'A';
        else if (estDwellSec >= 8) dwellGrade = 'B';

        return {
            firstLine: firstLine.slice(0, 80),
            hookTypes,
            charCount,
            lineCount,
            triggersReadMoreTap,
            estDwellSec,
            dwellGrade,
            tapExploreBonus
        };
    };

    // [2차 구조: On-Demand 상세 분석 모달 및 정밀 파서]
    const openDeepAnalysisModal = async (context) => {
        const {
            postCode,
            author = '',
            views = 0,
            likes = 0,
            replies = 0,
            reposts = 0,
            shares = 0,
            followers = 0,
            timeHours = 24,
            baseScore = 1,
            postRoot = null,
            container = null
        } = context || {};

        // 기존 모달 제거 후 생성
        let modalOverlay = document.getElementById('dreaths-deep-analysis-overlay');
        if (modalOverlay) modalOverlay.remove();

        modalOverlay = document.createElement('div');
        modalOverlay.id = 'dreaths-deep-analysis-overlay';
        modalOverlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(15, 23, 42, 0.65);
            backdrop-filter: blur(4px);
            z-index: 200000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
            font-family: 'Pretendard', -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
            -webkit-font-smoothing: antialiased;
        `;

        const modalCard = document.createElement('div');
        modalCard.id = 'dreaths-deep-analysis-modal';
        modalCard.style.cssText = `
            width: 100%;
            max-width: 650px;
            max-height: 88vh;
            overflow-y: auto;
            background: #FFFFFF;
            border: 1px solid #CBD5E1;
            border-radius: 16px;
            padding: 22px 24px;
            color: #0F172A;
            box-shadow: 0 24px 48px rgba(15, 23, 42, 0.28);
            position: relative;
            letter-spacing: -0.2px;
        `;

        modalOverlay.appendChild(modalCard);
        document.body.appendChild(modalOverlay);

        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) modalOverlay.remove();
        });

        // 초기 로딩 화면 표시 (고대비 화이트 카드 테마)
        modalCard.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #E2E8F0; padding-bottom:14px; margin-bottom:18px;">
                <div style="display:flex; align-items:center; gap:8px;">
                    <span style="background:#1E293B; color:#FFFFFF; font-size:10.5px; font-weight:700; padding:3px 8px; border-radius:6px; letter-spacing:0px;">META ALGORITHM 2.0</span>
                    <span style="font-size:16px; font-weight:700; color:#0F172A;">🔍 게시물 심층 알고리즘 분석</span>
                </div>
                <button id="dreaths-deep-close-btn" style="background:#F1F5F9; border:1px solid #CBD5E1; color:#334155; width:30px; height:30px; border-radius:8px; cursor:pointer; font-weight:700; font-size:14px;">✕</button>
            </div>
            <div style="padding:36px 20px; text-align:center;">
                <div style="display:inline-flex; align-items:center; gap:10px; background:#EFF6FF; border:1px solid #BFDBFE; padding:10px 18px; border-radius:24px; margin-bottom:12px;">
                    <span class="dreaths-pulse-dot" style="width:9px; height:9px; border-radius:50%; background:#2563EB; display:inline-block;"></span>
                    <span style="font-size:13px; font-weight:700; color:#1E40AF;">상세 페이지 및 답글 트리·체류 시그널을 정밀 분석하고 있습니다...</span>
                </div>
                <div style="font-size:12px; color:#475569; font-weight:500;">1시간·6시간 골든타임 답글 참여 / 대댓글 깊이 / 스크롤 스킵 방어력 / 토픽 태그 / 베이트 무결성 검증 중</div>
            </div>
        `;

        const bindClose = () => {
            const closeBtn = modalCard.querySelector('#dreaths-deep-close-btn');
            if (closeBtn) closeBtn.onclick = () => modalOverlay.remove();
        };
        bindClose();

        // 1. DOM 및 캐시에서 기본 텍스트/미디어/링크/태그 우선 확보
        const cachedPd = (postCode && window.DReaThsStats.posts && window.DReaThsStats.posts[postCode]) || {};
        let fullText = cachedPd.text || '';
        let mediaType = cachedPd.mediaType || '텍스트 전용';
        let hasExternalLink = false;
        let topicTags = [];
        let carouselCount = 1;

        const targetEl = container || postRoot;
        if (targetEl) {
            if (!fullText) {
                const textNodes = targetEl.querySelectorAll('div[dir="auto"], span[dir="auto"]');
                let longest = '';
                textNodes.forEach(n => {
                    const t = (n.innerText || '').trim();
                    if (t && !t.startsWith('@') && t !== author && t.length > longest.length) {
                        if (!['좋아요', '답글', '리포스트', '공유', '인용', '스레드', '팔로우', '번역하기'].includes(t)) {
                            longest = t;
                        }
                    }
                });
                fullText = longest;
            }
            const hasVideo = targetEl.querySelector('video') !== null;
            const imgs = targetEl.querySelectorAll('img[alt*="사진"], img[src*="cdninstagram"]');
            if (hasVideo) mediaType = '동영상';
            else if (imgs.length > 1) {
                carouselCount = imgs.length;
                mediaType = `캐러셀 (${imgs.length}장)`;
            } else if (imgs.length === 1) mediaType = '단일 이미지';

            const extLinks = targetEl.querySelectorAll('a[href^="http"]');
            extLinks.forEach(a => {
                const h = a.getAttribute('href') || '';
                if (h && !h.includes('threads.net') && !h.includes('threads.com') && !h.includes('instagram.com')) {
                    hasExternalLink = true;
                }
            });

            // 토픽 태그 또는 해시태그 추출
            const tagLinks = targetEl.querySelectorAll('a[href*="serp_type=tags"], a[href*="/search?q="]');
            tagLinks.forEach(a => {
                const t = (a.innerText || '').trim();
                if (t && t.length < 30 && !topicTags.includes(t)) topicTags.push(t);
            });
        }

        // 해시태그 보조 추출
        if (fullText) {
            const hashMatches = fullText.match(/#[가-힣A-Za-z0-9_]+/g);
            if (hashMatches) {
                hashMatches.forEach(hm => {
                    if (!topicTags.includes(hm)) topicTags.push(hm);
                });
            }
            if (/https?:\/\/[^\s]+/.test(fullText)) {
                hasExternalLink = true;
            }
        }

        // 2. 상세 페이지(/t/{postCode}) 비동기 정밀 크롤링 (실제 답글 타임스탬프, 대댓글, 작성자 티키타카 등 해부)
        let detailViews = views || cachedPd.views || 0;
        let detailLikes = likes || cachedPd.likes || 0;
        let detailReplies = replies || cachedPd.replies || 0;
        let detailReposts = reposts || cachedPd.reposts || 0;
        let detailShares = shares || cachedPd.shares || 0;
        let rootTakenAt = cachedPd.taken_at || null;

        let repliesIn1h = 0;
        let repliesIn6h = 0;
        let sampledRepliesCount = 0;
        let authorRepliesCount = 0;
        let nestedRepliesCount = 0;
        let authorThreadChainCount = 1;

        if (postCode) {
            try {
                const resp = await fetch(`${location.origin}/t/${postCode}`, {
                    credentials: 'include',
                    headers: { 'Accept': 'text/html' }
                });
                if (resp.ok) {
                    const html = await resp.text();

                    // 조회수/좋아요/답글 최신값 보강
                    const vMatch = html.match(/"view_count"\s*:\s*(\d+)/);
                    if (vMatch && parseInt(vMatch[1], 10) > detailViews) {
                        detailViews = parseInt(vMatch[1], 10);
                        window.DReaThsStats.views[postCode] = detailViews;
                    }

                    // 토픽 태그 추출 (JSON 내 tag_name / name)
                    for (const tm of html.matchAll(/"(?:tag_name|topic_name)"\s*:\s*"([^"]+)"/g)) {
                        try {
                            const decodedTag = JSON.parse(`"${tm[1]}"`);
                            if (decodedTag && !topicTags.includes(decodedTag)) topicTags.push(decodedTag);
                        } catch (e) {}
                    }

                    // 외부 고유 링크 첨부 여부 확인
                    if (html.includes('"link_preview_attachment"') || html.includes('"external_url"')) {
                        hasExternalLink = true;
                    }

                    // 상세 페이지 내 개별 포스트/답글 아이템 추출
                    const postBlocks = [];
                    const blockRegex = /"pk"\s*:\s*"(\d+)"[^]{0,2500}?"taken_at"\s*:\s*(\d+)/g;
                    for (const bm of html.matchAll(blockRegex)) {
                        const chunkStart = Math.max(0, bm.index - 600);
                        const chunkEnd = Math.min(html.length, bm.index + bm[0].length + 1200);
                        const chunk = html.substring(chunkStart, chunkEnd);

                        const takenAt = parseInt(bm[2], 10);
                        const codeM = chunk.match(/"code"\s*:\s*"([^"]+)"/);
                        const uM = chunk.match(/"username"\s*:\s*"([^"]+)"/);
                        const drM = chunk.match(/"direct_reply_count"\s*:\s*(\d+)/);
                        const lkM = chunk.match(/"like_count"\s*:\s*(\d+)/);
                        const txtM = chunk.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);

                        let parsedTxt = '';
                        if (txtM && txtM[1]) {
                            try { parsedTxt = JSON.parse(`"${txtM[1]}"`); } catch (e) { parsedTxt = txtM[1]; }
                        }

                        postBlocks.push({
                            code: codeM ? codeM[1] : null,
                            username: uM ? uM[1].toLowerCase() : '',
                            takenAt,
                            directReplies: drM ? parseInt(drM[1], 10) : 0,
                            likes: lkM ? parseInt(lkM[1], 10) : 0,
                            text: parsedTxt
                        });
                    }

                    // 원본 게시글 블록 식별
                    const rootBlock = postBlocks.find(b => b.code === postCode) || postBlocks[0];
                    if (rootBlock) {
                        if (!rootTakenAt && rootBlock.takenAt) rootTakenAt = rootBlock.takenAt;
                        if (!fullText && rootBlock.text) fullText = rootBlock.text;
                        if (rootBlock.likes > detailLikes) detailLikes = rootBlock.likes;
                        if (rootBlock.directReplies > detailReplies) detailReplies = rootBlock.directReplies;
                    }

                    // 답글 블록 분석 (1시간·6시간 골든타임 및 대댓글 티키타카)
                    const seenTimestamps = new Set();
                    postBlocks.forEach(b => {
                        if (b.code === postCode) return;
                        const key = `${b.username}_${b.takenAt}`;
                        if (seenTimestamps.has(key)) return;
                        seenTimestamps.add(key);

                        if (rootTakenAt && b.takenAt >= rootTakenAt) {
                            sampledRepliesCount++;
                            const diffSec = b.takenAt - rootTakenAt;
                            if (diffSec <= 3600) repliesIn1h++;
                            if (diffSec <= 21600) repliesIn6h++;

                            if (author && b.username === author.toLowerCase()) {
                                // 작성자가 본문 직후 3분 이내에 단 댓글은 '연쇄 스레드 타래(이어쓰기)', 이후는 '대댓글 티키타카'
                                if (diffSec <= 180) authorThreadChainCount++;
                                else authorRepliesCount++;
                            }
                            if (b.directReplies > 0) {
                                nestedRepliesCount++;
                            }
                        }
                    });
                }
            } catch (err) {
                console.warn('[DReaThs Deep Analysis] Detail fetch error:', err);
            }
        }

        // 3. 수집된 데이터 기반 메타 8장 슬라이드 정밀 스코어링
        let effectiveHours = timeHours;
        if (rootTakenAt && rootTakenAt > 0) {
            effectiveHours = Math.max(0.05, (Date.now() - rootTakenAt * 1000) / (1000 * 3600));
        }

        const hookDwell = analyzeHookAndDwell(fullText, mediaType, hasExternalLink);
        const baitCheck = detectEngagementBait(fullText);

        // 골든타임(1h/6h) 답글 모멘텀 계산
        const replyToLikeRatio = detailLikes > 0 ? (detailReplies / detailLikes) * 100 : (detailReplies > 0 ? 100 : 0);
        const golden1hRatio = sampledRepliesCount > 0 ? Math.round((repliesIn1h / sampledRepliesCount) * 100) : (effectiveHours <= 1 && detailReplies > 0 ? 100 : 0);
        const golden6hRatio = sampledRepliesCount > 0 ? Math.round((repliesIn6h / sampledRepliesCount) * 100) : (effectiveHours <= 6 && detailReplies > 0 ? 100 : 0);

        // 비팔로워 확산 배수 (Source 02 추천 피드 진입 지수)
        const effectiveFollowers = Math.max(followers || 0, 100);
        const spreadMultiple = (followers > 0 && detailViews > 0) ? (detailViews / followers) : 0;

        // ★ 메타 AI가 예측하는 '6가지 사용자 행동' 개별 예측 점수 (0~100점)
        // ① 좋아요 누르기 (Like the post)
        const likeRate = detailViews > 0 ? (detailLikes / detailViews) * 100 : 0;
        const action1LikeScore = Math.min(100, Math.round(detailLikes > 0 ? Math.min(likeRate * 18, 65) + Math.min(Math.log10(detailLikes + 1) * 15, 35) : 15));

        // ② 게시물 탭하기 (Tap the post - 상세/더보기/댓글창 열기)
        const action2TapPostScore = Math.min(100, Math.round(
            25 +
            (hookDwell.triggersReadMoreTap ? 30 : Math.min(hookDwell.charCount / 6, 20)) +
            (detailReplies >= 5 ? 25 : detailReplies * 5) +
            (hookDwell.hookTypes.includes('호기심/질문형') || hookDwell.hookTypes.includes('숫자/데이터형') ? 20 : 8)
        ));

        // ③ 탭하여 다른 게시물 보기 (Tap to explore more - 캐러셀/타래/링크)
        const action3ExploreScore = Math.min(100, Math.round(
            15 +
            hookDwell.tapExploreBonus +
            (authorThreadChainCount > 1 ? 25 : 0) +
            (nestedRepliesCount > 0 ? Math.min(nestedRepliesCount * 8, 25) : 0)
        ));

        // ④ 답글 작성하기 & 깊은 대화 (Compose a reply - 1h/6h 골든타임 & 대댓글)
        const action4ReplyScore = Math.min(100, Math.round(
            (detailReplies > 0 ? Math.min(Math.log2(detailReplies + 1) * 14, 45) : 5) +
            Math.min(replyToLikeRatio * 0.9, 25) +
            (golden6hRatio >= 40 ? 15 : 5) +
            ((authorRepliesCount > 0 || nestedRepliesCount > 0) ? 15 : 0)
        ));

        // ⑤ 프로필을 방문해 다른 게시물 보기 (Visit profile & view more - Source 02 비팔로워 유입)
        const action5ProfileVisitScore = Math.min(100, Math.round(
            20 +
            (spreadMultiple >= 10 ? 50 : spreadMultiple >= 3 ? 35 : spreadMultiple >= 1 ? 20 : 8) +
            (( detailReposts + detailShares ) > 0 ? Math.min((detailReposts + detailShares) * 4, 20) : 0) +
            (topicTags.length > 0 ? 10 : 0)
        ));

        // ⑥ [네거티브 방어] 스크롤하여 지나가기 방어력 (Scroll-past Defense - 체류시간 기반)
        const action6ScrollStopScore = Math.min(100, Math.round(
            Math.min(hookDwell.estDwellSec * 3.5, 70) +
            (hookDwell.hookTypes[0] !== '일반 서술형' ? 20 : 8) +
            (hasExternalLink ? 10 : 0)
        ));

        // ★ 2차 심층 알고리즘 종합 점수 산출 (1차 점수 + 메타 시그널 보정 + 베이트 페널티)
        const firstStageScore = baseScore > 1 ? baseScore : calcReactionScore({
            views: detailViews,
            likes: detailLikes,
            replies: detailReplies,
            reposts: detailReposts,
            shares: detailShares,
            followers: followers || 0,
            timeHours: effectiveHours
        });

        let deepSignalMultiplier = 1.0;
        // 골든타임 & 대댓글 티키타카 보너스
        if (detailReplies >= 3 && replyToLikeRatio >= 25) deepSignalMultiplier += 0.12;
        if (authorRepliesCount > 0 || nestedRepliesCount >= 2) deepSignalMultiplier += 0.10;
        if (golden1hRatio >= 50 && detailReplies >= 3) deepSignalMultiplier += 0.08;
        // 체류시간 & 탭 유도 보너스
        if (hookDwell.dwellGrade === 'S') deepSignalMultiplier += 0.10;
        else if (hookDwell.dwellGrade === 'A') deepSignalMultiplier += 0.05;
        // 베이트 페널티 적용
        deepSignalMultiplier *= baitCheck.penaltyFactor;

        const deepFinalScore = Math.max(1, Math.round(firstStageScore * deepSignalMultiplier));

        // AI 벤치마킹 코칭 인사이트 생성 (슬라이드 #8 추천 5가지 액션 매핑)
        const insights = [];
        if (hookDwell.dwellGrade === 'S' || hookDwell.dwellGrade === 'A') {
            insights.push(`✅ <b style="color:#0F172A;">[Action 1 · 도입부 & 체류시간]</b> 예상 체류시간 <b style="color:#047857;">약 ${hookDwell.estDwellSec}초(${hookDwell.dwellGrade}등급)</b>로 유일한 네거티브 시그널인 '스크롤 통과(Scroll past)' 방어력이 매우 뛰어납니다.`);
        } else {
            insights.push(`💡 <b style="color:#0F172A;">[Action 1 · 체류시간 보완]</b> 본문이 짧아 예상 체류시간이 <b style="color:#B45309;">약 ${hookDwell.estDwellSec}초</b>입니다. 첫 줄 후킹 강화나 캐러셀 이미지·타래 이어쓰기를 추가하면 스크롤 통과 방어력이 높아집니다.`);
        }

        if (detailReplies >= 3 && (replyToLikeRatio >= 20 || authorRepliesCount > 0 || nestedRepliesCount > 0)) {
            insights.push(`✅ <b style="color:#0F172A;">[Action 2 & 3 · 답글 골든타임 & 대화화]</b> 좋아요 대비 답글 전환율이 <b style="color:#0369A1;">${replyToLikeRatio.toFixed(1)}%</b>로 높고${authorRepliesCount > 0 ? ` 작성자 대댓글 참여(${authorRepliesCount}회)가 활발해` : ''} 메타가 중시하는 '깊은 대화 시그널'을 강하게 받고 있습니다.`);
        } else {
            insights.push(`💡 <b style="color:#0F172A;">[Action 2 & 3 · 답글 대화 유도]</b> 게시 후 <b style="color:#1D4ED8;">초기 1시간·6시간 내 답글과 대댓글(티키타카)</b>이 핵심 랭킹 시그널입니다. 본문 마지막 줄에 의견을 묻는 질문을 배치해보세요.`);
        }

        if (spreadMultiple >= 2.0) {
            insights.push(`✅ <b style="color:#0F172A;">[Source 02 · 추천 피드 돌파]</b> 팔로워 대비 조회수가 <b style="color:#047857;">${spreadMultiple.toFixed(1)}배</b>를 기록해 팔로워 피드(Source 01)를 넘어 AI 추천 피드(Source 02)로 강력하게 확산되었습니다.`);
        } else if (followers > 0 && detailViews > 0) {
            insights.push(`📊 <b style="color:#0F172A;">[Source 01 중심 노출]</b> 현재 팔로워 대비 확산 배수는 <b style="color:#334155;">${spreadMultiple.toFixed(1)}배</b>입니다. 토픽 태그(${topicTags.length > 0 ? topicTags.join(', ') : '미사용'})와 초기 1시간 대댓글 반응으로 비팔로워 추천 피드 진입을 노려보세요.`);
        }

        if (baitCheck.isBait) {
            insights.push(`⚠️ <b style="color:#B91C1C;">[슬라이드 #6 · 페널티 주의]</b> 본문에서 <b style="color:#B91C1C;">${baitCheck.matchedKeywords.join(', ')}</b> 패턴이 감지되었습니다. 메타 AI는 허위 참여 유도(Engagement Bait)를 식별해 랭킹 페널티를 부여하므로 문구 우회를 권장합니다.`);
        }

        const renderScoreBar = (label, sub, score, barColor) => `
            <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:10px 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:6px; white-space:nowrap;">
                    <div style="overflow:hidden; text-overflow:ellipsis;">
                        <span style="font-size:12.5px; font-weight:700; color:#0F172A;">${label}</span>
                        <span style="font-size:11px; font-weight:500; color:#64748B; margin-left:4px;">${sub}</span>
                    </div>
                    <span style="font-size:12.5px; font-weight:700; color:#0F172A; flex-shrink:0;">${score}<span style="font-size:10.5px; color:#64748B; font-weight:500;">/100</span></span>
                </div>
                <div style="width:100%; height:7px; background:#E2E8F0; border-radius:4px; overflow:hidden;">
                    <div style="width:${score}%; height:100%; background:${barColor}; border-radius:4px;"></div>
                </div>
            </div>
        `;

        modalCard.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #E2E8F0; padding-bottom:14px; margin-bottom:16px; gap:10px;">
                <div>
                    <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                        <span style="background:#1E293B; color:#FFFFFF; font-size:10.5px; font-weight:700; padding:3px 8px; border-radius:6px; letter-spacing:0px;">META ALGORITHM 2.0</span>
                        <span style="font-size:16px; font-weight:700; color:#0F172A;">@${author || 'user'} 게시물 심층 알고리즘 진단</span>
                    </div>
                    <div style="font-size:12px; color:#475569; font-weight:500;">메타 공식 6대 예측 행동 & 골든타임(1h·6h) & 체류시간 시그널 정밀 해부</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
                    <button id="dreaths-deep-scrap-btn" title="이 게시물을 DReaThs에 즉시 스크랩합니다" style="background:#059669; border:1px solid #10B981; color:#FFFFFF; height:32px; padding:0 12px; border-radius:8px; cursor:pointer; font-weight:700; font-size:12.5px; display:inline-flex; align-items:center; gap:5px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                        </svg>
                        <span>스크랩</span>
                    </button>
                    <button id="dreaths-deep-close-btn" style="background:#F1F5F9; border:1px solid #CBD5E1; color:#334155; width:32px; height:32px; border-radius:8px; cursor:pointer; font-weight:700; font-size:15px;">✕</button>
                </div>
            </div>

            <!-- 상단 요약 스코어 비교 -->
            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; margin-bottom:16px;">
                <div style="background:#EFF6FF; border:1px solid #BFDBFE; border-radius:12px; padding:11px 10px; text-align:center;">
                    <div style="font-size:11px; color:#1E40AF; font-weight:700; margin-bottom:4px;">1차 기본 ➔ 2차 심층점수</div>
                    <div style="font-size:15.5px; font-weight:700; color:#0F172A;">${firstStageScore}pt <span style="color:#1D4ED8;">➔ ${deepFinalScore}pt</span></div>
                </div>
                <div style="background:#F8FAFC; border:1px solid #CBD5E1; border-radius:12px; padding:11px 10px; text-align:center;">
                    <div style="font-size:11px; color:#475569; font-weight:600; margin-bottom:4px;">예상 체류시간 (스킵 방어)</div>
                    <div style="font-size:15.5px; font-weight:700; color:#047857;">약 ${hookDwell.estDwellSec}초 (${hookDwell.dwellGrade}등급)</div>
                </div>
                <div style="background:#F8FAFC; border:1px solid #CBD5E1; border-radius:12px; padding:11px 10px; text-align:center;">
                    <div style="font-size:11px; color:#475569; font-weight:600; margin-bottom:4px;">답글 대화 전환율</div>
                    <div style="font-size:15.5px; font-weight:700; color:#0369A1;">${replyToLikeRatio.toFixed(1)}% <span style="font-size:11.5px; color:#475569; font-weight:600;">(💬${detailReplies})</span></div>
                </div>
                <div style="background:${baitCheck.isBait ? '#FEF2F2' : '#F0FDF4'}; border:1px solid ${baitCheck.isBait ? '#FECACA' : '#BBF7D0'}; border-radius:12px; padding:11px 10px; text-align:center;">
                    <div style="font-size:11px; color:${baitCheck.isBait ? '#991B1B' : '#166534'}; font-weight:600; margin-bottom:4px;">알고리즘 페널티 검증</div>
                    <div style="font-size:14.5px; font-weight:700; color:${baitCheck.isBait ? '#B91C1C' : '#15803D'};">${baitCheck.isBait ? '⚠️ ' + baitCheck.riskLevel : '✅ 클린 (안전)'}</div>
                </div>
            </div>

            <!-- 도입부 Hook & 구조 & 골든타임 세부 지표 -->
            <div style="background:#F8FAFC; border:1px solid #CBD5E1; border-radius:12px; padding:14px 16px; margin-bottom:16px;">
                <div style="font-size:13px; font-weight:700; color:#0F172A; margin-bottom:8px;">📌 도입부 후킹(Hook) & 골든타임 답글 해부</div>
                <div style="font-size:12.5px; color:#1E293B; background:#FFFFFF; padding:9px 12px; border-radius:8px; margin-bottom:10px; border:1px solid #E2E8F0; border-left:4px solid #2563EB; line-height:1.45;">
                    <span style="color:#1D4ED8; font-weight:700; margin-right:4px;">[첫 줄 Hook]</span>${hookDwell.firstLine ? hookDwell.firstLine.replace(/</g, '&lt;') : '(텍스트 없음)'}
                </div>
                <div style="display:flex; flex-wrap:wrap; gap:6px; font-size:11.5px;">
                    <span style="background:#EEF2FF; color:#3730A3; border:1px solid #C7D2FE; padding:4px 9px; border-radius:6px; font-weight:600;">후킹 유형: ${hookDwell.hookTypes.join(' · ')}</span>
                    <span style="background:#F0F9FF; color:#075985; border:1px solid #BAE6FD; padding:4px 9px; border-radius:6px; font-weight:600;">분량: ${hookDwell.charCount}자 (${hookDwell.lineCount}줄) · ${mediaType}</span>
                    <span style="background:#FFFBEB; color:#92400E; border:1px solid #FDE68A; padding:4px 9px; border-radius:6px; font-weight:600;">
                        ${sampledRepliesCount > 0 ? `초기 1h 답글 ${repliesIn1h}건 / 6h 답글 ${repliesIn6h}건 (표본 ${sampledRepliesCount}건)` : `시간당 답글 속도 ${(detailReplies / Math.max(effectiveHours, 0.5)).toFixed(1)}개/h`}
                    </span>
                    <span style="background:#ECFDF5; color:#065F46; border:1px solid #A7F3D0; padding:4px 9px; border-radius:6px; font-weight:600;">
                        작성자 대댓글: ${authorRepliesCount}회 · 대댓글 파생: ${nestedRepliesCount}건
                    </span>
                    ${hasExternalLink ? `<span style="background:#F5F3FF; color:#5B21B6; border:1px solid #DDD6FE; padding:4px 9px; border-radius:6px; font-weight:600;">🔗 고유 외부링크 포함 (체류시그널+)</span>` : ''}
                    ${topicTags.length > 0 ? `<span style="background:#FDF2F8; color:#9D174D; border:1px solid #FBCFE8; padding:4px 9px; border-radius:6px; font-weight:600;">🏷️ 태그: ${topicTags.slice(0, 3).join(' ')}</span>` : ''}
                </div>
            </div>

            <!-- 메타 AI가 예측하는 6가지 사용자 행동 스코어카드 -->
            <div style="margin-bottom:16px;">
                <div style="font-size:13px; font-weight:700; color:#0F172A; margin-bottom:8px;">🤖 메타 AI 예측 '6가지 사용자 행동' 시그널 점수 (긍정 5 : 부정 방어 1)</div>
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                    ${renderScoreBar('① 좋아요 유도력', '좋아요 클릭 유도', action1LikeScore, '#E11D48')}
                    ${renderScoreBar('② 게시물 탭하기', '상세·더보기 클릭', action2TapPostScore, '#0284C7')}
                    ${renderScoreBar('③ 탭하여 더보기', '캐러셀·타래 탐색', action3ExploreScore, '#7C3AED')}
                    ${renderScoreBar('④ 답글·깊은 대화', '1h·6h 골든타임', action4ReplyScore, '#D97706')}
                    ${renderScoreBar('⑤ 프로필 방문 유도', '비팔로워 추천 유입', action5ProfileVisitScore, '#059669')}
                    ${renderScoreBar('⑥ 스크롤 통과 방어', '스크롤 스킵 방어', action6ScrollStopScore, '#2563EB')}
                </div>
            </div>

            <!-- 메타 공식 5대 액션 기반 벤치마킹 진단 -->
            <div style="background:#F8FAFC; border:1px solid #CBD5E1; border-radius:12px; padding:14px 16px;">
                <div style="font-size:13px; font-weight:700; color:#0F172A; margin-bottom:8px;">💡 메타 공식 가이드 기반 벤치마킹 인사이트</div>
                <div style="display:flex; flex-direction:column; gap:7px; font-size:12px; line-height:1.55; color:#1E293B;">
                    ${insights.map(item => `<div style="background:#FFFFFF; border:1px solid #E2E8F0; border-radius:8px; padding:8px 11px;">${item}</div>`).join('')}
                </div>
            </div>
        `;

        bindClose();
        const modalScrapBtn = modalCard.querySelector('#dreaths-deep-scrap-btn');
        if (modalScrapBtn) {
            modalScrapBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const origHtml = modalScrapBtn.innerHTML;
                modalScrapBtn.innerHTML = `<span>⏳ 스크랩 중...</span>`;
                modalScrapBtn.style.opacity = '0.7';
                modalScrapBtn.style.pointerEvents = 'none';

                const targetPost = container || postRoot || (postCode ? document.querySelector(`a[href*="/post/${postCode}"], a[href*="/t/${postCode}"]`)?.closest('[data-pressable-container="true"], article') : null);
                const extraContext = {
                    postCode,
                    author,
                    views: detailViews,
                    likes: detailLikes,
                    comments: detailReplies,
                    reposts: detailReposts,
                    shares: detailShares,
                    postRoot,
                    container
                };

                if (typeof processContainer === 'function') {
                    processContainer(targetPost, extraContext).finally(() => {
                        setTimeout(() => {
                            modalScrapBtn.innerHTML = origHtml;
                            modalScrapBtn.style.opacity = '1';
                            modalScrapBtn.style.pointerEvents = 'auto';
                        }, 1200);
                    });
                }
            };
        }
    };

    // ==========================================
    // Analytics UI 주입 (이슈 1, 2, 6 통합 해결)
    // ==========================================
    const DREATHS_VERSION = "1.129";
    console.log("============== DREATHS SCRAPER " + DREATHS_VERSION + " LOADED ==============");

    let overlayLayer = document.getElementById('dreaths-analytics-layer');
    if (!overlayLayer) {
        overlayLayer = document.createElement('div');
        overlayLayer.id = 'dreaths-analytics-layer';
        overlayLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9998;';
        document.body.appendChild(overlayLayer);
    }

    // 모달 감지 함수
    const isModalOpen = () => {
        // Threads는 모달을 열 때 body에 overflow:hidden을 걸거나
        // div[role="dialog"]가 나타남 (우리 자체 분석 모달은 제외)
        return !!document.querySelector('div[role="dialog"]:not(#dreaths-deep-analysis-modal)');
    };

    // 패널이 다음 게시글과 겹치는지 확인하고 레이아웃 결정
    const determinePanelLayout = (panelTop, panelHeight, containerRect, allContainerRects, idx) => {
        // 다음 게시글의 top 위치 확인
        const nextRect = (idx + 1 < allContainerRects.length) ? allContainerRects[idx + 1] : null;
        if (!nextRect) return 'vertical'; // 마지막 게시글이면 세로 유지

        const panelBottom = panelTop + panelHeight;
        const nextTop = window.scrollY + nextRect.top;

        // 패널이 다음 게시글 영역을 침범하면 가로(compact) 모드
        if (panelBottom > nextTop - 5) {
            return 'horizontal';
        }
        return 'vertical';
    };

    // ★ URL 변경 감지 → 페이지 전환 시 패널 초기화
    let lastUrl = location.href;
    const checkUrlChange = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            // 모든 기존 패널 제거 (페이지 전환)
            while (overlayLayer.firstChild) overlayLayer.removeChild(overlayLayer.firstChild);
            document.querySelectorAll('#dreaths-profile-dashboard, .dreaths-profile-dashboard').forEach(el => el.remove());
        }
    };
    setInterval(checkUrlChange, 300);

    // ★ DOM에서 "조회 N만회" 텍스트 직접 추출 (상세 페이지 헤더)
    const extractViewsFromDOM = () => {
        try {
            // "조회 5.0만회", "조회 1,234회", "조회 92,148회" 등의 텍스트 찾기
            const allText = document.querySelectorAll('span, div, header');
            for (const el of allText) {
                const text = el.textContent.trim();
                // "조회 N회" 패턴 매칭
                const viewMatch = text.match(/조회\s+([\d,.]+)(만|천|[KkMm])?\s*회/);
                if (viewMatch) {
                    let num = parseFloat(viewMatch[1].replace(/,/g, ''));
                    const unit = viewMatch[2] || '';
                    if (unit === '만') num *= 10000;
                    else if (unit === '천' || unit === 'K' || unit === 'k') num *= 1000;
                    else if (unit === 'M' || unit === 'm') num *= 1000000;

                    if (num > 0) {
                        // 현재 URL에서 게시글 코드 추출
                        const urlMatch = location.pathname.match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/);
                        if (urlMatch) {
                            window.DReaThsStats.views[urlMatch[1]] = Math.round(num);
                        }
                        // 모든 게시글 코드에 조회수 매핑 시도 (피드 내)
                        const postLinks = document.querySelectorAll('a[href*="/post/"], a[href*="/t/"]');
                        if (postLinks.length === 1) {
                            const linkMatch = postLinks[0].getAttribute('href').match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/);
                            if (linkMatch) {
                                window.DReaThsStats.views[linkMatch[1]] = Math.round(num);
                            }
                        }
                    }
                    break; // 첫 번째 매칭만 사용
                }
            }
        } catch(e) {}
    };
    setInterval(extractViewsFromDOM, 2000);



    const injectAnalyticsUI = () => {
        // 활동 페이지(/activity) 예외 처리: 반응도 분석 레이어 비활성화 및 조기 종료
        if (window.location.pathname.startsWith('/activity')) {
            if (overlayLayer) overlayLayer.style.display = 'none';
            return;
        }
        if (!dreathsShowEngagement) {
            if (overlayLayer) overlayLayer.style.display = 'none';
            return;
        }
        if (!overlayLayer || !document.body.contains(overlayLayer)) {
            overlayLayer = document.getElementById('dreaths-analytics-layer');
            if (!overlayLayer) {
                overlayLayer = document.createElement('div');
                overlayLayer.id = 'dreaths-analytics-layer';
                overlayLayer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 9998;';
                document.body.appendChild(overlayLayer);
            }
        }
        if (overlayLayer) overlayLayer.style.display = 'block';

        const allPressables = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
        const containers = allPressables.filter(c => {
            if (c.parentElement && c.parentElement.closest('div[data-pressable-container="true"]')) {
                return false;
            }

            // ★ 우측 사이드바 및 팔로우 추천 / 사용자 검색 결과 영역 완전 제외
            if (
                c.closest('[data-pagelet*="recommended_users"]') ||
                c.closest('[data-pagelet*="search_recommended_users"]') ||
                c.closest('[data-pagelet*="recommended_user"]') ||
                c.closest('aside')
            ) {
                return false;
            }

            // 우측 사이드바 컬럼 내부 컨테이너 여부 판별:
            // 주의: c의 조상으로 거슬러 올라가며 querySelector를 실행하면,
            // main 피드와 우측 사이드바의 공통 조상(최상위 레이아웃 wrapper)에 도달했을 때
            // 피드의 정상 게시글까지 사이드바로 오인되어 전체 반응도 패널이 사라지는 버그가 발생합니다.
            // 따라서 사이드바 루트 요소를 직접 찾아 c가 그 하위 요소인 경우에만 제외합니다.
            const rightSidebar = document.querySelector('[data-pagelet*="recommended_users"], [data-pagelet*="search_recommended_users"]')
                ?.closest('div[style*="width"], aside, div');
            if (rightSidebar && rightSidebar.contains(c)) {
                return false;
            }

            // 실제 게시글 여부 검증:
            // 실제 피드/상세 게시글은 post/t 고유 링크, time 태그, article 요소 중 최소 하나를 반드시 포함합니다.
            // 반면 우측 사이드바의 유저 추천 카드는 이 요소들이 전혀 없고 프로필 링크(@)와 팔로우 버튼만 존재합니다.
            const hasPostLink = !!c.querySelector('a[href*="/post/"], a[href*="/t/"]');
            const inArticle = !!c.closest('article, div[role="article"]');
            const hasTimeTag = !!c.querySelector('time');
            if (!hasPostLink && !inArticle && !hasTimeTag) {
                return false;
            }

            // ★ 복합 스레드 체인(원본글 + 인라인 답글 미리보기)에서 하위 인라인 답글 미리보기 제외
            // 피드에서 동일 article 내에 메인 게시글과 인라인 답글이 함께 렌더링된 경우,
            // 첫 번째 컨테이너가 원본 분석 대상이며, 두 번째 이후는 인라인 답글 미리보기이므로 패널 중복/겹침 방지
            const article = c.closest('article, div[role="article"]');
            if (article) {
                const pressablesInArticle = Array.from(article.querySelectorAll('div[data-pressable-container="true"]')).filter(p => {
                    return !p.parentElement || !p.parentElement.closest('div[data-pressable-container="true"]');
                });
                if (pressablesInArticle.length > 1) {
                    const isRepliesTab = window.location.pathname.includes('/replies');
                    if (!isRepliesTab && c !== pressablesInArticle[0]) {
                        return false;
                    }
                }
            }
            return true;
        });
        const modalOpen = isModalOpen();

        // 기존 패널 정리: 대응 게시글이 없는 패널 제거
        const existingPanels = Array.from(overlayLayer.children);
        existingPanels.forEach(panel => {
            const code = panel.getAttribute('data-dreaths-code');
            if (!code || !containers.some(c => c.getAttribute('data-dreaths-post-id') === code)) {
                panel.remove();
            }
        });

        // 뷰포트 정보
        const viewportTop = window.scrollY;
        const viewportBottom = viewportTop + window.innerHeight;
        const viewportLeft = window.scrollX;
        const viewportRight = viewportLeft + window.innerWidth;

        // 모달 영역 감지
        let modalRect = null;
        if (modalOpen) {
            const dialogEl = document.querySelector('div[role="dialog"]');
            if (dialogEl) {
                modalRect = dialogEl.getBoundingClientRect();
            }
        }

        // 컨테이너 rect 미리 계산
        const containerRects = containers.map(c => c.getBoundingClientRect());

        containers.forEach((container, idx) => {
            if (!container.hasAttribute('data-dreaths-post-id')) {
                container.setAttribute('data-dreaths-post-id', 'dreaths_post_' + Math.random().toString(36).substr(2, 9));
            }
            const uniqueId = container.getAttribute('data-dreaths-post-id');

            const rect = containerRects[idx];
            if (rect.width === 0 || rect.height === 0) return;

            const absoluteTop = window.scrollY + rect.top;
            const absoluteLeft = window.scrollX + rect.left;

            // ★ 이슈 2 해결: 뷰포트 가시성 체크
            const containerTop = rect.top;
            const containerBottom = rect.bottom;
            const isInViewport = containerBottom > 0 && containerTop < window.innerHeight;

            // 모달이 열린 경우: 모달 내부 게시글만 표시
            if (modalOpen && modalRect) {
                const isInModal = (
                    rect.top >= modalRect.top - 10 &&
                    rect.bottom <= modalRect.bottom + 10 &&
                    rect.left >= modalRect.left - 10 &&
                    rect.right <= modalRect.right + 10
                );
                if (!isInModal) {
                    // 모달 밖 게시글의 패널은 숨김
                    const existingUi = overlayLayer.querySelector(`[data-dreaths-code="${uniqueId}"]`);
                    if (existingUi) existingUi.style.display = 'none';
                    return;
                }
            }

            // 뷰포트 밖이면 숨김
            if (!isInViewport) {
                const existingUi = overlayLayer.querySelector(`[data-dreaths-code="${uniqueId}"]`);
                if (existingUi) existingUi.style.display = 'none';
                return;
            }

            let ui = overlayLayer.querySelector(`[data-dreaths-code="${uniqueId}"]`);
            if (!ui) {
                ui = document.createElement('div');
                ui.className = 'dreaths-analytics-panel';
                ui.setAttribute('data-dreaths-code', uniqueId);
                ui.style.cssText = `
                    position: absolute;
                    background: #1a1a1a;
                    border: 1px solid #333;
                    border-radius: 8px;
                    padding: 8px 10px;
                    font-size: 11px;
                    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
                    z-index: 9999;
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    color: #ffffff;
                    pointer-events: auto;
                `;
                overlayLayer.appendChild(ui);
            }

            // 게시글 root 및 작성자/게시글 코드 엄격 탐색 (인접 게시글 혼선 완전 차단)
            const postRoot = findStrictPostRoot(container);
            let { author, postCode } = extractPostMeta(postRoot, container);
            const currentProfileUser = typeof getProfileUsername === 'function' ? getProfileUsername() : null;
            if (!author && currentProfileUser) author = currentProfileUser;
            if (author) author = author.toLowerCase().replace(/^@/, '');

            // 팔로워 수 다단계 Fallback 탐색
            let followers = 0;
            if (author && window.DReaThsStats.followers[author]) {
                followers = window.DReaThsStats.followers[author];
            } else if (author && window.DReaThsStats.followers[author.toLowerCase()]) {
                followers = window.DReaThsStats.followers[author.toLowerCase()];
            } else if (author && window.DReaThsStats.profiles && window.DReaThsStats.profiles[author]?.followers) {
                followers = window.DReaThsStats.profiles[author].followers;
            } else if (currentProfileUser && window.DReaThsStats.followers[currentProfileUser]) {
                followers = window.DReaThsStats.followers[currentProfileUser];
            } else if (currentProfileUser && window.DReaThsStats.profiles && window.DReaThsStats.profiles[currentProfileUser]?.followers) {
                followers = window.DReaThsStats.profiles[currentProfileUser].followers;
            } else if (postCode && window.DReaThsStats.posts && window.DReaThsStats.posts[postCode]?.authorFollowers) {
                followers = window.DReaThsStats.posts[postCode].authorFollowers;
            }
            if (followers > 0 && author && !window.DReaThsStats.followers[author]) {
                window.DReaThsStats.followers[author] = followers;
            }

            let viewCount = (postCode && window.DReaThsStats.views[postCode]) || 
                            (postCode && window.DReaThsStats.posts && window.DReaThsStats.posts[postCode]?.views) || 
                            undefined;

            // 프로필에 캐시된 viewsList가 있다면 인덱스/코드 매칭으로 보충
            if ((viewCount === undefined || viewCount === 0) && currentProfileUser && window.DReaThsStats.profiles && window.DReaThsStats.profiles[currentProfileUser]) {
                const profObj = window.DReaThsStats.profiles[currentProfileUser];
                if (profObj && profObj.postCodes && postCode) {
                    const pIdx = profObj.postCodes.indexOf(postCode);
                    if (pIdx !== -1 && profObj.viewsList && profObj.viewsList[pIdx] > 0) {
                        viewCount = profObj.viewsList[pIdx];
                        if (postCode) window.DReaThsStats.views[postCode] = viewCount;
                    }
                }
            }

            // ★ 실시간 반응도 즉시 우선순위 요청 (화면에 노출된 게시물 즉각 백그라운드 수확)
            if (isInViewport) {
                if (author && (followers === undefined || followers === 0)) {
                    queueTarget({ type: 'profile', key: author, highPriority: true });
                }
                if (postCode && (viewCount === undefined || viewCount === 0)) {
                    if (author && (followers === undefined || followers === 0)) {
                        queueTarget({ type: 'profile', key: author, highPriority: true });
                    } else {
                        queueTarget({ type: 'post', key: postCode, highPriority: true });
                    }
                }
            }

            // DOM에서 조회수 추출 시도 (강화된 다국어/줄바꿈 정규식 로직)
            if (!viewCount || viewCount === undefined) {
                const searchEl = (postRoot && postRoot.querySelectorAll('div[data-pressable-container="true"]').length <= 1) ? postRoot : container;
                const allSpans = Array.from(searchEl.querySelectorAll('span, div, time, header'));
                for (const s of allSpans) {
                    const text = (s.textContent || '').trim();
                    if (!text || text.length > 50) continue;
                    const viewMatch = text.match(/(?:조회수?\s*|views?\s*:?\s*)([\d,.]+(?:만|천|[KkMm])?)\s*회?/i) ||
                                      text.match(/([\d,.]+(?:만|천|[KkMm])?)\s*(?:회\s*조회|views?)/i);
                    if (viewMatch && viewMatch[1]) {
                        const parsedViews = parseFormattedNumber(viewMatch[1]);
                        if (parsedViews > 0) {
                            viewCount = parsedViews;
                            if (postCode) window.DReaThsStats.views[postCode] = viewCount;
                            break;
                        }
                    }
                }
            }

            // ★ 이슈 1 해결: 항상 패널 표시 (추출 버튼 없음)
            // DOM에서 좋아요/답글/리포스트 등 추출 (개선된 로직 - container 우선 스캔으로 타 글 혼선 원천 차단)
            let domLikes = 0, domReplies = 0, domReposts = 0, domShares = 0;

            const svgs = (container.querySelectorAll('svg').length > 0)
                ? container.querySelectorAll('svg')
                : postRoot.querySelectorAll('svg');
            svgs.forEach(svg => {
                const label = svg.getAttribute('aria-label') ||
                              svg.querySelector('title')?.textContent?.trim() ||
                              svg.getAttribute('title') ||
                              svg.closest('button, [role="button"]')?.getAttribute('aria-label') ||
                              svg.closest('button, [role="button"]')?.getAttribute('title') ||
                              '';
                if (!label) return;
                const num = findNumberForSvg(svg);
                if (num > 0) {
                    const l = label.toLowerCase();
                    if (l.includes('좋아') || l.includes('like')) domLikes = num;
                    if (l.includes('답글') || l.includes('reply') || l.includes('comment')) domReplies = num;
                    if (l.includes('리포스트') || l.includes('인용') || l.includes('repost') || l.includes('quote')) domReposts = num;
                    if (l.includes('공유') || l.includes('share') || l.includes('보내기') || l.includes('send')) domShares = num;
                }
            });

            // fallback: 텍스트 및 액션바 직접 정규식 매칭
            if (domLikes === 0 || domReplies === 0 || domReposts === 0 || domShares === 0) {
                const postText = (container.innerText || postRoot.innerText || '');
                const likeM = postText.match(/(?:좋아요\s*([0-9,.]+(?:만|천|[KkMm])?)\s*개?|([0-9,.]+(?:만|천|[KkMm])?)\s*개의?\s*좋아요)/);
                if (likeM && domLikes === 0) domLikes = parseFormattedNumber(likeM[1] || likeM[2]);
                const replyM = postText.match(/(?:답글\s*([0-9,.]+(?:만|천|[KkMm])?)\s*개?|([0-9,.]+(?:만|천|[KkMm])?)\s*개의?\s*답글)/);
                if (replyM && domReplies === 0) domReplies = parseFormattedNumber(replyM[1] || replyM[2]);
                const repostM = postText.match(/(?:리포스트\s*([0-9,.]+(?:만|천|[KkMm])?)\s*(?:회|개)?|([0-9,.]+(?:만|천|[KkMm])?)\s*개의?\s*리포스트)/);
                if (repostM && domReposts === 0) domReposts = parseFormattedNumber(repostM[1] || repostM[2]);
                const shareM = postText.match(/(?:공유하기|공유|보내기)\s*([0-9,.]+(?:만|천|[KkMm])?)\s*(?:회|개)?/);
                if (shareM && domShares === 0) domShares = parseFormattedNumber(shareM[1]);
            }

            // 캐시 데이터 Fallback (프로필 대시보드나 API/GraphQL 등에서 기수집된 인터랙션 및 조회수 보충)
            const cachedPost = postCode && window.DReaThsStats.posts && window.DReaThsStats.posts[postCode];
            if (cachedPost) {
                if (domLikes === 0 && cachedPost.likes) domLikes = cachedPost.likes;
                if (domReplies === 0 && cachedPost.replies) domReplies = cachedPost.replies;
                if (domReposts === 0 && cachedPost.reposts) domReposts = cachedPost.reposts;
                if (domShares === 0 && cachedPost.shares) domShares = cachedPost.shares;
                if ((!viewCount || viewCount === 0) && cachedPost.views) viewCount = cachedPost.views;
                if (!followers && cachedPost.authorFollowers) followers = cachedPost.authorFollowers;
            }

            // 반대로 DOM에서 추출된 값이 있으면 캐시에 최신화 보관
            if (postCode) {
                if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                const pd = window.DReaThsStats.posts[postCode] || {};
                pd.likes = Math.max(pd.likes || 0, domLikes);
                pd.replies = Math.max(pd.replies || 0, domReplies);
                pd.reposts = Math.max(pd.reposts || 0, domReposts);
                pd.shares = Math.max(pd.shares || 0, domShares);
                if (viewCount > 0) {
                    pd.views = Math.max(pd.views || 0, viewCount);
                    window.DReaThsStats.views[postCode] = pd.views;
                }
                if (author && !pd.author) pd.author = author;
                if (followers > 0 && !pd.authorFollowers) pd.authorFollowers = followers;
                window.DReaThsStats.posts[postCode] = pd;
            }

            // 시간 계산 (정밀 타임스탬프 datetime / taken_at 우선 활용)
            let timeHours = null;
            const pd = window.DReaThsStats.posts && window.DReaThsStats.posts[postCode];
            if (pd && pd.timeHours) {
                timeHours = pd.timeHours;
            } else if (pd && pd.taken_at && pd.taken_at > 0) {
                timeHours = Math.max((Date.now() - (pd.taken_at * 1000)) / (1000 * 60 * 60), 0.05);
            } else if (pd && pd.datetime) {
                const postTime = new Date(pd.datetime).getTime();
                if (!isNaN(postTime) && postTime > 0) {
                    timeHours = Math.max((Date.now() - postTime) / (1000 * 60 * 60), 0.05);
                }
            }
            if (!timeHours) {
                const timeEl = postRoot.querySelector('time');
                if (timeEl) {
                    const dt = timeEl.getAttribute('datetime');
                    if (dt) {
                        const postTime = new Date(dt).getTime();
                        if (!isNaN(postTime) && postTime > 0) {
                            timeHours = Math.max((Date.now() - postTime) / (1000 * 60 * 60), 0.05);
                        }
                    }
                    if (!timeHours) {
                        const timeText = timeEl.textContent;
                        if (timeText.includes('분') || timeText.includes('m')) timeHours = parseInt(timeText) / 60;
                        else if (timeText.includes('시간') || timeText.includes('h')) timeHours = parseInt(timeText);
                        else if (timeText.includes('일') || timeText.includes('d')) timeHours = parseInt(timeText) * 24;
                    }
                }
            }
            if (!timeHours || isNaN(timeHours) || timeHours <= 0) timeHours = 24;
            if (pd) pd.timeHours = timeHours;

            // ★ 메트릭 계산
            // 반응도 공식: (좋아요×2 + 댓글×3 + 공유×3 + 리포스트×4)
            const weightedScore = (domLikes * 2) + (domReplies * 3) + (domShares * 3) + (domReposts * 4);
            const totalEngagement = domLikes + domReplies + domReposts + domShares;
            const hasViews = viewCount !== undefined && viewCount > 0;
            const hasFollowers = followers !== undefined && followers > 0;

            // 숫자 포맷팅 (만/천 단위 변환)
            const formatNum = (n) => {
                if (n === undefined || n === null) return '—';
                if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
                if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '만';
                if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + '천';
                return n.toLocaleString();
            };

            let reactionRate, reactionDisplay, perHour, spreadVal, engageRate, shareSpeed, compositeScore, statusEmoji, headlineColor;
            let spreadRatio = 0;

            if (hasViews) {
                // 1) 조회수가 있을 때의 정밀 계산
                reactionRate = (weightedScore / viewCount * 100);
                perHour = Math.round(viewCount / timeHours).toLocaleString();
                spreadRatio = (hasFollowers && followers > 0) ? (viewCount / followers) : 0;
                spreadVal = hasFollowers ? spreadRatio.toFixed(1) : '—';
                engageRate = viewCount > 0 ? ((totalEngagement / viewCount) * 100).toFixed(2) : '0.00';
                shareSpeed = ((domReposts + domShares) / viewCount * 100).toFixed(1) + '%';
            } else {
                // 2) 🌟 [스마트 Fallback 엔진]: 조회수를 아직 못 가져왔을 때 (인터랙션/팔로워 기반 산출)
                perHour = Math.round(totalEngagement / Math.max(timeHours, 0.5)).toLocaleString();
                shareSpeed = totalEngagement > 0 ? (((domReposts + domShares) / totalEngagement) * 100).toFixed(1) + '%' : '—';

                if (hasFollowers) {
                    engageRate = ((totalEngagement / followers) * 100).toFixed(2);
                    spreadVal = ((totalEngagement * 10) / followers).toFixed(1);
                    spreadRatio = parseFloat(spreadVal) || 0;
                    reactionRate = (weightedScore / followers) * 100;
                } else {
                    engageRate = totalEngagement > 0 ? totalEngagement.toFixed(2) : '0.00';
                    spreadVal = '—';
                    reactionRate = weightedScore;
                }
            }

            // 대시보드와 우측 플로팅 패널의 완벽 동기화 (단일 반응도 엔진)
            if (pd && pd.reactionScore && pd.reactionScore > 1) {
                // 단, views가 뒤늦게 발견되어 0에서 양수가 된 경우에만 재계산
                if (!hasViews || (pd.views && pd.views === viewCount)) {
                    compositeScore = pd.reactionScore;
                }
            }

            if (!compositeScore) {
                if (hasViews) {
                    compositeScore = calcReactionScore({
                        views: viewCount,
                        likes: domLikes,
                        replies: domReplies,
                        reposts: domReposts,
                        shares: domShares,
                        followers: followers || 0,
                        timeHours: timeHours
                    });
                } else {
                    compositeScore = calcReactionScore({
                        views: 0,
                        likes: domLikes,
                        replies: domReplies,
                        reposts: domReposts,
                        shares: domShares,
                        followers: followers || 0,
                        timeHours: timeHours
                    });
                }
            }

            // 양방향 캐시 동기화: 산출된 공식 점수 보관
            if (postCode && compositeScore > 0) {
                if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                if (!window.DReaThsStats.posts[postCode]) window.DReaThsStats.posts[postCode] = {};
                window.DReaThsStats.posts[postCode].reactionScore = compositeScore;
            }

            if (compositeScore !== null && compositeScore > 0) {
                if (compositeScore >= 500) { statusEmoji = '💥'; headlineColor = '#FDA4AF'; }
                else if (compositeScore >= 200) { statusEmoji = '🔥'; headlineColor = '#FB7185'; }
                else if (compositeScore >= 120) { statusEmoji = '🚀'; headlineColor = '#FCD34D'; }
                else if (compositeScore >= 50) { statusEmoji = '📈'; headlineColor = '#86EFAC'; }
                else { statusEmoji = '📊'; headlineColor = '#CBD5E1'; }
                reactionDisplay = `${statusEmoji} ${compositeScore}pt`;
            } else if (totalEngagement > 0) {
                statusEmoji = '📊';
                headlineColor = '#86EFAC';
                reactionDisplay = `${statusEmoji} ${totalEngagement} 반응`;
            } else {
                statusEmoji = '📊';
                headlineColor = '#94A3B8';
                reactionDisplay = hasViews ? '0pt' : '수집중';
            }

            // ★ 이슈 6 해결: 레이아웃 결정 (세로 vs 가로)
            const PANEL_HEIGHT_VERTICAL = 262;
            const layout = determinePanelLayout(absoluteTop + 20, PANEL_HEIGHT_VERTICAL, rect, containerRects, idx);

            const currentDataHash = `${layout}_${compositeScore || 'x'}_${viewCount || 'x'}_${followers || 'x'}_${engageRate || 'x'}_${perHour}_${spreadVal}_${shareSpeed}_${domLikes}_${domReplies}_${domReposts}_${domShares}`;
            ui.style.display = 'flex';
            ui._currentPostRoot = postRoot;
            ui._currentContainer = container;
            ui._currentPostCode = postCode;
            ui._currentAuthor = author;
            ui._currentViews = viewCount;
            ui._currentFollowers = followers;
            ui._currentTimeHours = timeHours;
            ui._currentScore = compositeScore;
            ui._currentStats = {
                likes: domLikes,
                comments: domReplies,
                reposts: domReposts,
                shares: domShares,
                views: viewCount
            };

            if (ui.dataset.dreathsHash !== currentDataHash) {
                ui.dataset.dreathsHash = currentDataHash;

                // ★ 다크 테마 공통 스타일 (부드러운 파스텔/슬레이트 조화)
                ui.style.background = '#18191d';
                ui.style.border = '1px solid #2e323b';
                ui.style.borderRadius = '10px';
                ui.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.35)';
                ui.style.color = '#F1F5F9';

                const rowStyle = 'display:flex; justify-content:space-between; align-items:center; padding:1px 0;';
                const labelStyle = 'color:#94A3B8; font-size:10px; font-weight:500;';
                const valueStyle = 'font-weight:700; color:#F1F5F9; font-size:11px;';

                if (layout === 'horizontal') {
                    // ★ 가로 2줄 레이아웃
                    ui.style.flexDirection = 'column';
                    ui.style.width = 'auto';
                    ui.style.maxWidth = '480px';
                    ui.style.gap = '4px';
                    ui.style.padding = '6px 10px';
                    ui.style.alignItems = '';

                    const itemStyle = 'font-size:10px; color:#CBD5E1; white-space:nowrap;';
                    ui.innerHTML = `
                        <div style="display:flex; gap:10px; align-items:center; justify-content:space-between;">
                            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                                <div style="font-weight:900; color:${headlineColor}; font-size:13px; white-space:nowrap;">반응도 ${reactionDisplay}</div>
                                <div style="${itemStyle}">조회 ${formatNum(viewCount)}</div>
                                <div style="${itemStyle}">팔로워 ${formatNum(followers)}</div>
                            </div>
                            <div style="display:flex; gap:5px; align-items:center;">
                                <button class="dreaths-deep-analyze-btn" title="메타 알고리즘 8대 시그널 기준 심층 분석을 실행합니다" style="
                                    background:#2563EB;
                                    color:#FFFFFF;
                                    border:1px solid #3B82F6;
                                    border-radius:5px;
                                    padding:2px 7px;
                                    font-size:10px;
                                    font-weight:700;
                                    cursor:pointer;
                                    display:inline-flex;
                                    align-items:center;
                                    gap:3px;
                                    transition:filter 0.15s ease;
                                    white-space:nowrap;
                                ">
                                    <span>🔍 상세분석</span>
                                </button>
                                <button class="dreaths-card-scrap-btn" title="이 게시물을 DReaThs에 즉시 스크랩합니다" style="
                                     background:#059669;
                                     color:#FFFFFF;
                                     border:1px solid #10B981;
                                     border-radius:5px;
                                     padding:2px 7px;
                                     font-size:10px;
                                     font-weight:700;
                                     cursor:pointer;
                                     display:inline-flex;
                                     align-items:center;
                                     gap:3px;
                                     transition:filter 0.15s ease;
                                     white-space:nowrap;
                                 ">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                    <span>스크랩</span>
                                </button>
                            </div>
                        </div>
                        <div style="display:flex; gap:10px; align-items:center; border-top:1px solid #2e323b; padding-top:3px;">
                            <div style="${itemStyle}">인게이지 ${engageRate !== null ? engageRate + '%' : '—'}</div>
                            <div style="${itemStyle}">시간당 조회 ${perHour}</div>
                            <div style="${itemStyle}">공유속도 ${shareSpeed}</div>
                            <div style="${itemStyle}">확산 ${spreadVal}</div>
                        </div>
                    `;
                } else {
                    // ★ 세로 레이아웃
                    ui.style.flexDirection = 'column';
                    ui.style.width = '112px';
                    ui.style.maxWidth = '';
                    ui.style.gap = '3px';
                    ui.style.padding = '8px 10px';
                    ui.style.alignItems = '';

                    ui.innerHTML = `
                        <div style="font-weight:900; color:${headlineColor}; text-align:center; margin-bottom:4px; font-size:13px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:4px;">
                            반응도<br>${reactionDisplay}
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">조회</span>
                            <span style="${valueStyle}">${formatNum(viewCount)}</span>
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">팔로워</span>
                            <span style="${valueStyle}">${formatNum(followers)}</span>
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">인게이지</span>
                            <span style="${valueStyle}">${engageRate !== null ? engageRate + '%' : '—'}</span>
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">시간당 조회</span>
                            <span style="${valueStyle}">${perHour}</span>
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">공유속도</span>
                            <span style="${valueStyle}">${shareSpeed}</span>
                        </div>
                        <div style="${rowStyle}">
                            <span style="${labelStyle}">확산</span>
                            <span style="${valueStyle} ${spreadRatio >= 30 ? 'color:#C4B5FD; font-weight:800;' : ''}">${spreadVal}${hasFollowers && spreadRatio > 0 ? '배' : ''}</span>
                        </div>
                        <div style="border-top:1px solid #2e323b; margin-top:4px; padding-top:4px; display:flex; flex-direction:column; gap:4px;">
                            <button class="dreaths-deep-analyze-btn" title="메타 알고리즘 8대 시그널 기준 심층 분석을 실행합니다" style="
                                width:100%;
                                box-sizing:border-box;
                                background:#2563EB;
                                color:#FFFFFF;
                                border:1px solid #3B82F6;
                                border-radius:6px;
                                padding:4.5px 0;
                                font-size:10.5px;
                                font-weight:700;
                                cursor:pointer;
                                display:flex;
                                align-items:center;
                                justify-content:center;
                                gap:3px;
                                transition:filter 0.15s ease;
                                user-select:none;
                            ">
                                <span>🔍 상세 분석</span>
                            </button>
                            <button class="dreaths-card-scrap-btn" title="이 게시물을 DReaThs에 즉시 스크랩합니다" style="
                                width:100%;
                                box-sizing:border-box;
                                background:#059669;
                                color:#FFFFFF;
                                border:1px solid #10B981;
                                border-radius:6px;
                                padding:4.5px 0;
                                font-size:10.5px;
                                font-weight:700;
                                cursor:pointer;
                                display:flex;
                                align-items:center;
                                justify-content:center;
                                gap:4px;
                                transition:filter 0.15s ease;
                                user-select:none;
                            ">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
                                </svg>
                                <span>스크랩</span>
                            </button>
                        </div>
                    `;
                }

                const deepBtn = ui.querySelector('.dreaths-deep-analyze-btn');
                if (deepBtn) {
                    deepBtn.onmouseenter = () => { deepBtn.style.filter = 'brightness(1.15)'; };
                    deepBtn.onmouseleave = () => { deepBtn.style.filter = 'brightness(1)'; };
                    deepBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openDeepAnalysisModal({
                            postCode: ui._currentPostCode || postCode,
                            author: ui._currentAuthor || author,
                            views: ui._currentViews ?? viewCount ?? 0,
                            likes: ui._currentStats?.likes ?? domLikes ?? 0,
                            replies: ui._currentStats?.comments ?? domReplies ?? 0,
                            reposts: ui._currentStats?.reposts ?? domReposts ?? 0,
                            shares: ui._currentStats?.shares ?? domShares ?? 0,
                            followers: ui._currentFollowers ?? followers ?? 0,
                            timeHours: ui._currentTimeHours ?? timeHours ?? 24,
                            baseScore: ui._currentScore ?? compositeScore ?? 1,
                            postRoot: ui._currentPostRoot || postRoot,
                            container: ui._currentContainer || container
                        });
                    };
                }

                const scrapBtn = ui.querySelector('.dreaths-card-scrap-btn');
                if (scrapBtn) {
                    scrapBtn.onmouseenter = () => {
                        scrapBtn.style.filter = 'brightness(1.15)';
                    };
                    scrapBtn.onmouseleave = () => {
                        scrapBtn.style.filter = 'brightness(1)';
                    };
                    scrapBtn.onclick = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const origHtml = scrapBtn.innerHTML;
                        scrapBtn.innerHTML = `<span>⏳ 스크랩 중...</span>`;
                        scrapBtn.style.opacity = '0.7';
                        scrapBtn.style.pointerEvents = 'none';

                        const targetPost = ui._currentContainer || container || ui._currentPostRoot || postRoot;
                        const extraContext = {
                            postCode: ui._currentPostCode || postCode,
                            author: ui._currentAuthor || author,
                            views: ui._currentViews ?? viewCount,
                            likes: ui._currentStats?.likes ?? domLikes,
                            comments: ui._currentStats?.comments ?? domReplies,
                            reposts: ui._currentStats?.reposts ?? domReposts,
                            shares: ui._currentStats?.shares ?? domShares,
                            postRoot: ui._currentPostRoot || postRoot,
                            container: ui._currentContainer || container
                        };

                        if (typeof processContainer === 'function') {
                            processContainer(targetPost, extraContext).finally(() => {
                                setTimeout(() => {
                                    scrapBtn.innerHTML = origHtml;
                                    scrapBtn.style.opacity = '1';
                                    scrapBtn.style.pointerEvents = 'auto';
                                }, 1200);
                            });
                        }
                    };
                }
            }

            // 위치 설정
            ui.style.top = (absoluteTop + 20) + 'px';
            ui.style.left = (absoluteLeft + rect.width + 10) + 'px';
        });

        // 충돌 감지: 겹치는 패널 처리
        const panels = Array.from(overlayLayer.children).filter(p => p.style.display !== 'none');
        for (let i = 0; i < panels.length; i++) {
            for (let j = i + 1; j < panels.length; j++) {
                const p1 = panels[i];
                const p2 = panels[j];
                const top1 = parseFloat(p1.style.top) || 0;
                const top2 = parseFloat(p2.style.top) || 0;
                const left1 = parseFloat(p1.style.left) || 0;
                const left2 = parseFloat(p2.style.left) || 0;

                if (Math.abs(top1 - top2) < 80 && Math.abs(left1 - left2) < 80) {
                    const laterPanel = top2 > top1 ? p2 : p1;
                    laterPanel.style.left = (parseFloat(laterPanel.style.left) - 130) + 'px';
                }
            }
        }
    };

    // ==========================================
    // ★ 프로필 메인 대시보드 (Profile Insights Dashboard)
    // ==========================================
    const getProfileUsername = () => {
        const m = location.pathname.match(/^\/@([A-Za-z0-9_.]+)(?:\/(?:threads|replies|reposts))?\/?$/);
        if (!m) return null;
        const u = m[1];
        if (['post', 't', 'settings', 'search', 'notifications', 'messages'].includes(u.toLowerCase())) return null;
        return u;
    };

    const findProfileDashboardMountPoint = () => {
        // 1. 프로필 탭 컨테이너 검색 (Threads, Replies, Reposts 링크 그룹)
        const tabLinks = document.querySelectorAll('a[href*="/replies"], a[href*="/reposts"], a[href*="/threads"]');
        for (const link of tabLinks) {
            let parent = link.parentElement;
            while (parent && parent !== document.body) {
                const siblings = parent.querySelectorAll('a[href*="/replies"], a[href*="/reposts"], a[href*="/threads"]');
                if (siblings.length >= 2) {
                    return parent;
                }
                parent = parent.parentElement;
            }
        }
        // 2. 피드 내 첫 번째 게시물 컨테이너 상단
        const firstPost = document.querySelector('article, div[data-pressable-container="true"]');
        if (firstPost && firstPost.parentElement) {
            return firstPost;
        }
        return null;
    };

    const formatDashboardNum = (n) => {
        if (n === undefined || n === null || isNaN(n)) return '—';
        if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, '') + '억';
        if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, '') + '만';
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + '천';
        return n.toLocaleString();
    };


    // ==========================================
    // 프로필 게시물 분석 데이터 엑셀(CSV) 내보내기 헬퍼
    // ==========================================
    const enrichProfilePostsFromDOM = (username) => {
        try {
            const prof = window.DReaThsStats.profiles && window.DReaThsStats.profiles[username];
            const articles = document.querySelectorAll('article, div[data-pressable-container="true"]');
            articles.forEach(art => {
                // 1. 해당 게시글의 작성자 검증 (다른 사람의 추천/외부 게시글 엄격 차단)
                const authorLink = art.querySelector('a[href^="/@"]:not([href*="/post/"]), a[href*="threads.net/@"]:not([href*="/post/"]), a[href*="threads.com/@"]:not([href*="/post/"])');
                if (authorLink) {
                    const href = authorLink.getAttribute('href') || '';
                    const mUser = href.match(/@([A-Za-z0-9_.]+)/);
                    if (mUser && mUser[1].toLowerCase() !== username.toLowerCase()) {
                        return; // 다른 사용자의 추천 게시글이므로 절대 포함하지 않음!
                    }
                }

                let code = null;
                const links = art.querySelectorAll('a[href*="/post/"], a[href*="/t/"]');
                for (const a of links) {
                    const m = (a.getAttribute('href') || '').match(/\/(?:post|t)\/([A-Za-z0-9_-]+)/);
                    if (m) {
                        code = m[1];
                        break;
                    }
                }
                if (!code) return;

                if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                const pd = window.DReaThsStats.posts[code] || {};
                pd.author = username;

                // 2. 작성일 (<time datetime="...">)
                const timeEl = art.querySelector('time[datetime]');
                if (timeEl) {
                    const dt = timeEl.getAttribute('datetime');
                    if (dt) pd.datetime = dt;
                }

                // 3. 본문
                if (!pd.text) {
                    const textNodes = art.querySelectorAll('div[dir="auto"], span[dir="auto"]');
                    let bestText = '';
                    textNodes.forEach(node => {
                        const txt = (node.innerText || '').trim();
                        if (txt && !txt.startsWith('@') && txt !== username && txt.length > bestText.length) {
                            if (!['좋아요', '답글', '리포스트', '공유', '인용', '스레드', '팔로우', '번역하기'].includes(txt)) {
                                bestText = txt;
                            }
                        }
                    });
                    if (bestText) pd.text = bestText;
                }

                // 4. 미디어 첨부방식
                if (!pd.mediaType || pd.mediaType === '텍스트 전용') {
                    const hasVideo = art.querySelector('video') !== null;
                    const imgs = art.querySelectorAll('img[alt*="사진"], img[src*="cdninstagram"]');
                    if (hasVideo) {
                        pd.mediaType = '동영상';
                    } else if (imgs.length > 1) {
                        pd.mediaType = `캐러셀 (${imgs.length}장)`;
                    } else if (imgs.length === 1) {
                        pd.mediaType = '단일 이미지';
                    } else {
                        pd.mediaType = '텍스트 전용';
                    }
                }

                // 5. 인터랙션 지표 (좋아요, 댓글, 리포스트, 공유, 인용)
                const svgs = art.querySelectorAll('svg');
                svgs.forEach(svg => {
                    const label = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '').toLowerCase();
                    const num = typeof findNumberForSvg === 'function' ? findNumberForSvg(svg) : 0;
                    if (label.includes('좋아') || label.includes('like')) {
                        if (num > 0 || pd.likes === undefined) pd.likes = num;
                    } else if (label.includes('답글') || label.includes('reply') || label.includes('comment')) {
                        if (num > 0 || pd.replies === undefined) pd.replies = num;
                    } else if (label.includes('리포스트') || label.includes('repost')) {
                        if (num > 0 || pd.reposts === undefined) pd.reposts = num;
                    } else if (label.includes('공유') || label.includes('share')) {
                        if (num > 0 || pd.shares === undefined) pd.shares = num;
                    } else if (label.includes('인용') || label.includes('quote')) {
                        if (num > 0 || pd.quotes === undefined) pd.quotes = num;
                    }
                });

                window.DReaThsStats.posts[code] = pd;

                // 6. DOM에서 확인된 현재 유저의 정상 게시글은 prof.postCodes에 동기화
                if (prof && !prof.postCodes.includes(code)) {
                    prof.postCodes.push(code);
                    const v = pd.views || window.DReaThsStats.views[code] || 0;
                    prof.viewsList.push(v);
                }
            });
        } catch(e) {
            console.warn('[DReaThs CSV] enrichProfilePostsFromDOM error:', e);
        }
    };

    const formatPostDate = (taken_at, datetimeStr) => {
        let d = null;
        if (taken_at) {
            d = new Date(taken_at * 1000);
        } else if (datetimeStr) {
            d = new Date(datetimeStr);
        }
        if (!d || isNaN(d.getTime())) return '—';
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const formatRelativeTime = (taken_at, datetimeStr) => {
        let d = null;
        if (taken_at) {
            d = new Date(taken_at * 1000);
        } else if (datetimeStr) {
            d = new Date(datetimeStr);
        }
        if (!d || isNaN(d.getTime())) return '';
        const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
        if (diffSec < 60) return '방금 전';
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}시간 전`;
        if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}일 전`;
        return `${d.getMonth() + 1}월 ${d.getDate()}일`;
    };

    const escapeCsvField = (val) => {
        if (val === undefined || val === null) return '""';
        const str = String(val);
        return `"${str.replace(/"/g, '""')}"`;
    };

    const exportProfileCsv = (username, prof, followers) => {
        enrichProfilePostsFromDOM(username);

        const rawCodes = (prof && prof.postCodes && prof.postCodes.length > 0)
            ? prof.postCodes
            : Object.keys(window.DReaThsStats.posts || {});

        const postCodes = rawCodes.filter(c => {
            const pd = window.DReaThsStats.posts && window.DReaThsStats.posts[c];
            if (pd && pd.author && pd.author.toLowerCase() !== username.toLowerCase()) return false;
            return true;
        });

        if (postCodes.length === 0) {
            alert('분석된 게시물 데이터가 아직 없습니다. 잠시 후 다시 시도해주세요.');
            return;
        }

        const headers = [
            '작성일',
            '글주소',
            '본문',
            '도입부 첫줄(Hook)',
            '미디어 첨부방식',
            '조회수',
            '좋아요',
            '댓글',
            '리포스트',
            '공유',
            '인용',
            '반응도 지표',
            '확산 배수(Source02)',
            '대화 깊이(댓글/좋아요 비)',
            '예상 체류시간(초)',
            '알고리즘 무결성(베이트 여부)'
        ];

        const rows = [];

        postCodes.forEach((code, idx) => {
            const pd = (window.DReaThsStats.posts && window.DReaThsStats.posts[code]) || {};
            const postUrl = `https://www.threads.net/@${username}/post/${code}`;
            const dateStr = formatPostDate(pd.taken_at, pd.datetime);
            const text = (pd.text || '').trim();
            const media = pd.mediaType || '텍스트 전용';
            const views = pd.views || (prof?.viewsList && prof.viewsList[idx]) || 0;
            const likes = pd.likes || 0;
            const replies = pd.replies || 0;
            const reposts = pd.reposts || 0;
            const shares = pd.shares || 0;
            const quotes = pd.quotes || 0;

            let th = 24;
            if (pd.timeHours) {
                th = pd.timeHours;
            } else if (pd.taken_at && pd.taken_at > 0) {
                th = Math.max(0.05, (Date.now() - (pd.taken_at * 1000)) / (1000 * 3600));
            } else if (pd.datetime) {
                const postTime = new Date(pd.datetime).getTime();
                if (!isNaN(postTime) && postTime > 0) {
                    th = Math.max(0.05, (Date.now() - postTime) / (1000 * 3600));
                }
            }
            const score = pd.reactionScore || calcReactionScore({
                views,
                likes,
                replies,
                reposts,
                shares,
                followers: followers || 0,
                timeHours: th
            });

            // 고도화 4: 메타 알고리즘 분석 컬럼 데이터 산출 (0ms 즉시 계산)
            const hasExtLink = /https?:\/\/[^\s]+/.test(text);
            const hookDwell = analyzeHookAndDwell(text, media, hasExtLink);
            const baitInfo = detectEngagementBait(text);
            const spreadMultiple = (followers > 0 && views > 0) ? `${(views / followers).toFixed(2)}배` : '—';
            const replyRatioStr = likes > 0 ? `${((replies / likes) * 100).toFixed(1)}%` : (replies > 0 ? '100%' : '0%');
            const dwellStr = `${hookDwell.estDwellSec}초 (${hookDwell.dwellGrade}등급)`;
            const baitStr = baitInfo.isBait ? `${baitInfo.riskLevel} (${baitInfo.matchedKeywords.join('/')})` : '클린';

            rows.push([
                escapeCsvField(dateStr),
                escapeCsvField(postUrl),
                escapeCsvField(text),
                escapeCsvField(hookDwell.firstLine),
                escapeCsvField(media),
                escapeCsvField(views),
                escapeCsvField(likes),
                escapeCsvField(replies),
                escapeCsvField(reposts),
                escapeCsvField(shares),
                escapeCsvField(quotes),
                escapeCsvField(`${score}pt`),
                escapeCsvField(spreadMultiple),
                escapeCsvField(replyRatioStr),
                escapeCsvField(dwellStr),
                escapeCsvField(baitStr)
            ].join(','));
        });

        const csvContent = headers.map(escapeCsvField).join(',') + '\r\n' + rows.join('\r\n');
        // UTF-8 BOM (\uFEFF) 삽입으로 한국어 윈도우 엑셀에서도 인코딩 깨짐 없이 바로 열림
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const nowStr = new Date().toISOString().slice(0, 10);
        link.download = `${username}_스레드_게시물분석_${nowStr}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    let lastProfileFetchTime = 0;
    let lastRenderedUsername = null;

    const renderProfileDashboard = () => {
        const username = getProfileUsername();
        
        // DOM 내 모든 대시보드 검색 및 중복 인스턴스 전량 제거
        const allDashes = Array.from(document.querySelectorAll('#dreaths-profile-dashboard, .dreaths-profile-dashboard'));
        if (allDashes.length > 1) {
            for (let i = 1; i < allDashes.length; i++) {
                allDashes[i].remove();
            }
        }
        let existingDash = allDashes[0] || null;

        if (!username) {
            if (existingDash) existingDash.remove();
            lastRenderedUsername = null;
            return;
        }

        // 현재 프로필 데이터 확인 및 부재/전환 시 즉시 fetch 트리거
        const prof = window.DReaThsStats.profiles && window.DReaThsStats.profiles[username];
        const now = Date.now();
        if (username !== lastRenderedUsername) {
            lastRenderedUsername = username;
            lastProfileFetchTime = now;
            fetchProfileData(username);
        } else if ((!prof || prof.viewsList.length === 0) && !prof?.isAnalyzing && now - lastProfileFetchTime > 5000) {
            lastProfileFetchTime = now;
            fetchProfileData(username);
        }

        enrichProfilePostsFromDOM(username);

        // ★ 타인/추천 게시글 오염 정화 (Sanitization):
        // prof.postCodes에 담긴 게시글 중 작성자가 username과 다른 글은 즉시 영구 배제
        if (prof && prof.postCodes && prof.postCodes.length > 0) {
            const validCodes = [];
            const validViews = [];
            prof.postCodes.forEach((c, idx) => {
                const pd = window.DReaThsStats.posts && window.DReaThsStats.posts[c];
                if (pd && pd.author && pd.author.toLowerCase() !== username.toLowerCase()) {
                    return; // 타인 작성 추천 게시글 배제
                }
                validCodes.push(c);
                const v = (pd && pd.views) || (prof.viewsList && prof.viewsList[idx]) || 0;
                validViews.push(v);
            });
            prof.postCodes = validCodes;
            prof.viewsList = validViews;
        }

        const isAnalyzing = prof ? Boolean(prof.isAnalyzing) : false;
        const followers = window.DReaThsStats.followers[username] || (prof ? prof.followers : null) || 0;
        // 안정적인 순서 보장을 위해 prof.viewsList 직접 활용
        const views = prof && prof.viewsList && prof.viewsList.length > 0 ? prof.viewsList : [];

        // 평균 조회수 및 최고 조회수
        const avgViews = views.length > 0 ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : 0;
        const maxViews = views.length > 0 ? Math.max(...views, 1) : 1;

        // 평균 인터랙션 (좋아요/댓글/리포스트 종합 스캔)
        let totalInteractions = 0;
        let countedPosts = 0;
        if (prof && prof.postCodes && prof.postCodes.length > 0) {
            prof.postCodes.forEach(code => {
                const pd = window.DReaThsStats.posts && window.DReaThsStats.posts[code];
                if (pd && (pd.likes !== undefined || pd.replies !== undefined)) {
                    totalInteractions += ((pd.likes || 0) + (pd.replies || 0) + (pd.reposts || 0));
                    countedPosts++;
                }
            });
        }
        if (countedPosts === 0) {
            const articles = document.querySelectorAll('article, div[data-pressable-container="true"]');
            articles.forEach(art => {
                const authorLink = art.querySelector('a[href^="/@"]:not([href*="/post/"]), a[href*="threads.net/@"]:not([href*="/post/"]), a[href*="threads.com/@"]:not([href*="/post/"])');
                if (authorLink) {
                    const href = authorLink.getAttribute('href') || '';
                    const mUser = href.match(/@([A-Za-z0-9_.]+)/);
                    if (mUser && mUser[1].toLowerCase() !== username.toLowerCase()) {
                        return; // 타인 게시글 스킵!
                    }
                }
                let artLikes = 0, artReplies = 0;
                const svgs = art.querySelectorAll('svg');
                svgs.forEach(svg => {
                    const label = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || '').toLowerCase();
                    const num = findNumberForSvg(svg);
                    if (num > 0) {
                        if (label.includes('좋아') || label.includes('like')) artLikes = num;
                        if (label.includes('답글') || label.includes('reply') || label.includes('comment')) artReplies = num;
                    }
                });
                if (artLikes > 0 || artReplies > 0) {
                    totalInteractions += (artLikes + artReplies);
                    countedPosts++;
                }
            });
        }
        const avgInteractions = countedPosts > 0 ? Math.round(totalInteractions / countedPosts) : 0;

        // ★ 각 게시물별 우리 확장프로그램 반응도 지표 점수(pt) 산출
        const postScores = [];
        if (prof && prof.postCodes && prof.postCodes.length > 0) {
            prof.postCodes.forEach((code, idx) => {
                const pd = (window.DReaThsStats.posts && window.DReaThsStats.posts[code]) || {};
                const v = pd.views || (window.DReaThsStats.views && window.DReaThsStats.views[code]) || (views[idx] !== undefined ? views[idx] : 0);
                const l = pd.likes || 0;
                const r = pd.replies || 0;
                const rep = pd.reposts || 0;
                const sh = pd.shares || 0;
                let th = 24;
                if (pd.timeHours) {
                    th = pd.timeHours;
                } else if (pd.taken_at && pd.taken_at > 0) {
                    th = Math.max(0.05, (Date.now() - (pd.taken_at * 1000)) / (1000 * 3600));
                } else if (pd.datetime) {
                    const postTime = new Date(pd.datetime).getTime();
                    if (!isNaN(postTime) && postTime > 0) {
                        th = Math.max(0.05, (Date.now() - postTime) / (1000 * 3600));
                    }
                }
                pd.timeHours = th;

                // injectAnalyticsUI(우측 플로팅 패널)와 100% 동일한 반응도 점수 산출 및 양방향 동기화
                let score = pd.reactionScore;
                if (!score || score <= 1 || (v > 0 && (!pd.views || pd.views === 0))) {
                    score = calcReactionScore({
                        views: v,
                        likes: l,
                        replies: r,
                        reposts: rep,
                        shares: sh,
                        followers: followers,
                        timeHours: th
                    });
                }
                pd.reactionScore = score;
                pd.views = v;
                if (code) {
                    if (!window.DReaThsStats.posts) window.DReaThsStats.posts = {};
                    window.DReaThsStats.posts[code] = pd;
                    if (v > 0) window.DReaThsStats.views[code] = v;
                }

                postScores.push({
                    code,
                    score,
                    views: v,
                    likes: l,
                    replies: r,
                    reposts: rep,
                    shares: sh,
                    timeHours: th,
                    text: pd.text || '',
                    datetime: pd.datetime,
                    taken_at: pd.taken_at,
                    mediaType: pd.mediaType || '게시물'
                });
            });
        } else if (views.length > 0) {
            views.forEach((v) => {
                const score = calcReactionScore({ views: v, followers: followers });
                postScores.push({
                    code: null,
                    score,
                    views: v,
                    likes: 0,
                    replies: 0,
                    reposts: 0,
                    shares: 0,
                    timeHours: 24,
                    text: '',
                    datetime: null,
                    taken_at: null,
                    mediaType: '게시물'
                });
            });
        }

        const maxScore = postScores.length > 0 ? Math.max(...postScores.map(p => p.score), 1) : 1;
        const avgScore = postScores.length > 0 ? Math.round(postScores.reduce((a, b) => a + b.score, 0) / postScores.length) : 0;

        // ★ 고반응도 & 터진 게시글 (Top Breakout Posts) 선별 (상위 3개까지)
        const sortedPosts = [...postScores].sort((a, b) => b.score - a.score);
        let breakoutPosts = sortedPosts.filter(p => {
            return p.score >= 120 || p.score === maxScore || (followers > 0 && p.views > 0 && (p.views / followers) >= 2.0);
        });
        if (breakoutPosts.length === 0 && sortedPosts.length > 0) {
            breakoutPosts = sortedPosts.slice(0, 1);
        } else {
            breakoutPosts = breakoutPosts.slice(0, 3);
        }

        // ★ 최근 게시물 반응도 추이 차트 데이터 구성
        // 1) 고정글(Pinned)이나 스크롤 순서 왜곡 방지를 위해 타임스탬프 기준 최신순(내림차순) 정렬
        const getPostTime = (p) => {
            if (p.taken_at && p.taken_at > 0) return p.taken_at * 1000;
            if (p.datetime) {
                const t = new Date(p.datetime).getTime();
                if (!isNaN(t) && t > 0) return t;
            }
            return null;
        };

        const sortedByTimeDesc = [...postScores].sort((a, b) => {
            const tA = getPostTime(a);
            const tB = getPostTime(b);
            if (tA !== null && tB !== null) return tB - tA; // 최신글이 앞(index 0)에 오도록 정렬
            if (tA !== null) return -1;
            if (tB !== null) return 1;
            return 0;
        });

        // 2) 항상 가장 '최근' 게시물 최대 16개를 선택 (스크롤을 내려 과거 글이 추가되어도 최근 글 16개가 고정 유지됨)
        const recentPosts = sortedByTimeDesc.slice(0, 16);

        // 3) 차트의 X축은 '왼쪽(과거/이전) → 오른쪽(최신)'이므로 시간순(오름차순)으로 반전
        const displayedPosts = [...recentPosts].reverse();
        const chartMaxScore = displayedPosts.length > 0 ? Math.max(...displayedPosts.map(p => p.score), 1) : 1;

        // ==========================================
        // ★ [고도화 3] 메타 공식 알고리즘 5대 액션 계정 진단 (0ms 기수집 데이터 기반)
        // ==========================================
        let meta5ActionsHtml = '';
        if (postScores.length > 0) {
            // Action 1: 도입부 후킹 & 체류시간 유도력 (스크롤 스킵 방어)
            const dwellList = postScores.map(p => analyzeHookAndDwell(p.text, p.mediaType, /https?:\/\/[^\s]+/.test(p.text || '')).estDwellSec);
            const avgDwellSec = Math.round(dwellList.reduce((a, b) => a + b, 0) / dwellList.length);
            const mediaOrLongCount = postScores.filter(p => (p.mediaType && p.mediaType !== '텍스트 전용' && p.mediaType !== '게시물') || (p.text && p.text.length >= 140)).length;
            const dwellRichPct = Math.round((mediaOrLongCount / postScores.length) * 100);

            // Action 2 & 3: 답글 및 깊은 대화 활성도 (댓글/좋아요 비율 및 평균 댓글)
            const totalLikesSum = postScores.reduce((a, b) => a + (b.likes || 0), 0);
            const totalRepliesSum = postScores.reduce((a, b) => a + (b.replies || 0), 0);
            const avgReplies = (totalRepliesSum / postScores.length).toFixed(1);
            const replyToLikePct = totalLikesSum > 0 ? Math.round((totalRepliesSum / totalLikesSum) * 100) : (totalRepliesSum > 0 ? 100 : 0);

            // Action 4: 추천 피드(Source 02) 돌파력 & 프로필 유입 견인력
            const avgSpreadRatio = (followers > 0 && avgViews > 0) ? (avgViews / followers) : 0;
            const source2BreakoutCount = followers > 0 ? postScores.filter(p => p.views >= followers * 1.5).length : 0;

            // Action 5: 일관되게 게시하기 — 업로드 주기 및 이력 분석
            const validTimes = sortedByTimeDesc.map(p => getPostTime(p)).filter(t => t !== null);
            let cadenceText = '주기 분석중';
            let cadenceSub = '타임스탬프 수집중';
            let cadenceColor = '#94A3B8';
            if (validTimes.length >= 2) {
                let gapSumHours = 0;
                let gapCount = 0;
                for (let i = 0; i < validTimes.length - 1; i++) {
                    const diffH = Math.abs(validTimes[i] - validTimes[i + 1]) / (1000 * 3600);
                    // 고정글(Pinned) 등으로 인한 비정상 점프(30일 이상) 제외
                    if (diffH >= 0.05 && diffH <= 720) {
                        gapSumHours += diffH;
                        gapCount++;
                    }
                }
                if (gapCount > 0) {
                    const avgGapH = gapSumHours / gapCount;
                    if (avgGapH <= 18) {
                        cadenceText = `일 평균 ${(24 / Math.max(avgGapH, 2)).toFixed(1)}회`;
                        cadenceSub = 'S등급 (초고밀도 이력)';
                        cadenceColor = '#059669';
                    } else if (avgGapH <= 36) {
                        cadenceText = `약 ${Math.round(avgGapH)}시간 주기`;
                        cadenceSub = 'A등급 (일관성 우수)';
                        cadenceColor = '#0284C7';
                    } else if (avgGapH <= 84) {
                        cadenceText = `약 ${(avgGapH / 24).toFixed(1)}일 주기`;
                        cadenceSub = 'B등급 (주 2~3회 유지)';
                        cadenceColor = '#D97706';
                    } else {
                        cadenceText = `약 ${Math.round(avgGapH / 24)}일 주기`;
                        cadenceSub = 'C등급 (업로드 간격 김)';
                        cadenceColor = '#DC2626';
                    }
                }
            }

            // 슬라이드 #6: 알고리즘 페널티(인게이지먼트 베이트) 클린 지수
            const baitPostCount = postScores.filter(p => detectEngagementBait(p.text).isBait).length;
            const cleanPct = Math.round(((postScores.length - baitPostCount) / postScores.length) * 100);

            meta5ActionsHtml = `
                <div style="background:#F8FAFC; border:1px solid #CBD5E1; border-radius:14px; padding:14px 16px; margin-top:14px; color:#0F172A;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:6px;">
                        <div style="display:flex; align-items:center; gap:7px;">
                            <span style="background:#1E293B; color:#FFFFFF; font-size:10px; font-weight:700; padding:2.5px 7px; border-radius:5px;">META 5 ACTIONS</span>
                            <span style="font-size:12.5px; font-weight:700; color:#0F172A; letter-spacing:-0.2px;">메타 공식 알고리즘 5대 시그널 진단</span>
                        </div>
                        <span style="font-size:10.5px; color:#475569; font-weight:600;">기수집 게시물 ${postScores.length}개 즉시 분석</span>
                    </div>
                    <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:8px;">
                        <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:9px 8px; text-align:center;">
                            <div style="font-size:10.5px; color:#475569; font-weight:600; margin-bottom:3px;">① 체류·스킵방어</div>
                            <div style="font-size:13.5px; font-weight:700; color:#1D4ED8;">약 ${avgDwellSec}초</div>
                            <div style="font-size:10px; color:#64748B; font-weight:500; margin-top:2px;">미디어·장문 ${dwellRichPct}%</div>
                        </div>
                        <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:9px 8px; text-align:center;">
                            <div style="font-size:10.5px; color:#475569; font-weight:600; margin-bottom:3px;">② 답글·대화화</div>
                            <div style="font-size:13.5px; font-weight:700; color:#0369A1;">평균 ${avgReplies}개</div>
                            <div style="font-size:10px; color:#64748B; font-weight:500; margin-top:2px;">대화비중 ${replyToLikePct}%</div>
                        </div>
                        <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:9px 8px; text-align:center;">
                            <div style="font-size:10.5px; color:#475569; font-weight:600; margin-bottom:3px;">③ 추천피드 돌파</div>
                            <div style="font-size:13.5px; font-weight:700; color:#7C3AED;">${avgSpreadRatio > 0 ? avgSpreadRatio.toFixed(1) + '배' : '—'}</div>
                            <div style="font-size:10px; color:#64748B; font-weight:500; margin-top:2px;">추천확산 ${source2BreakoutCount}건</div>
                        </div>
                        <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:9px 8px; text-align:center;">
                            <div style="font-size:10.5px; color:#475569; font-weight:600; margin-bottom:3px;">④ 게시 일관성</div>
                            <div style="font-size:12.5px; font-weight:700; color:${cadenceColor};">${cadenceText}</div>
                            <div style="font-size:10px; color:#64748B; font-weight:500; margin-top:2px;">${cadenceSub}</div>
                        </div>
                        <div style="background:#FFFFFF; border:1px solid #CBD5E1; border-radius:10px; padding:9px 8px; text-align:center;">
                            <div style="font-size:10.5px; color:#475569; font-weight:600; margin-bottom:3px;">⑤ 베이트 무결성</div>
                            <div style="font-size:13.5px; font-weight:700; color:${baitPostCount === 0 ? '#15803D' : '#B91C1C'};">${cleanPct}% 클린</div>
                            <div style="font-size:10px; color:#64748B; font-weight:500; margin-top:2px;">${baitPostCount === 0 ? '페널티 위험 없음' : `주의 문구 ${baitPostCount}건`}</div>
                        </div>
                    </div>
                </div>
            `;
        }

        // 인게이지먼트율 (ER) 및 성과 배수 처리 (비정상 수치 235039% 방지 및 명확한 분기)
        let metric4Label = '참여율 (ER)';
        let metric4Val = '—';
        if (avgViews > 0 && avgInteractions > 0) {
            metric4Val = ((avgInteractions / avgViews) * 100).toFixed(2) + '%';
        } else if (followers > 0 && avgViews > 0) {
            metric4Label = '성과 배수';
            metric4Val = (avgViews / followers).toFixed(1) + '배';
        }

        const breakoutHash = breakoutPosts.map(p => (p.code || '') + p.score).join(',');
        const chartHash = displayedPosts.map(p => (p.code || '') + p.score).join(',');
        const dataHash = `${username}_${followers}_${views.length}_${avgViews}_${avgScore}_${maxScore}_${avgInteractions}_${metric4Val}_${isAnalyzing}_${breakoutHash}_${chartHash}`;

        const mountPoint = findProfileDashboardMountPoint();
        if (!mountPoint || !mountPoint.parentNode) return;

        let dashEl = existingDash;
        if (!dashEl) {
            const siblingDash = mountPoint.parentElement?.querySelector('.dreaths-profile-dashboard, #dreaths-profile-dashboard');
            if (siblingDash) {
                dashEl = siblingDash;
            } else {
                dashEl = document.createElement('div');
                dashEl.id = 'dreaths-profile-dashboard';
                dashEl.className = 'dreaths-profile-dashboard';
                mountPoint.parentNode.insertBefore(dashEl, mountPoint);
            }
        } else if (dashEl.parentNode && dashEl.nextElementSibling !== mountPoint && mountPoint.parentNode) {
            mountPoint.parentNode.insertBefore(dashEl, mountPoint);
        }

        if (dashEl.dataset.hash === dataHash) return;
        dashEl.dataset.hash = dataHash;

        // 스타일 적용 (모던 슬레이트 / 파스텔 조화)
        dashEl.style.cssText = `
            margin: 16px auto 20px auto;
            width: 100%;
            max-width: 620px;
            box-sizing: border-box;
            background: var(--card-background, #18191d);
            border: 1px solid var(--lines-primary, rgba(255, 255, 255, 0.1));
            border-radius: 16px;
            padding: 16px 20px;
            color: var(--primary-text, #F1F5F9);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
            position: relative;
            z-index: 99;
        `;

        const cardBg = 'background: var(--secondary-background, rgba(125, 125, 125, 0.06)); border: 1px solid var(--lines-secondary, rgba(125, 125, 125, 0.1));';
        const cardStyle = `${cardBg} border-radius:12px; padding:12px 10px; text-align:center; display:flex; flex-direction:column; justify-content:center;`;
        const cardLabelStyle = 'font-size:11px; color:#64748B; font-weight:600; margin-bottom:5px;';
        const cardValStyle = 'font-size:17px; font-weight:800; letter-spacing:-0.2px;';

        // 사용자 피드백 반영: 실시간 분석 중 진행 상황(몇 개째 분석 중...) 명확 표시
        let statusBadgeHtml = '';
        if (isAnalyzing) {
            const countText = prof && prof.totalTargetCount && prof.totalTargetCount > 0
                ? `${views.length}/${prof.totalTargetCount}개째 분석 중...`
                : `${views.length}개째 분석 중...`;
            statusBadgeHtml = `
                <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(245, 158, 11, 0.12); border:1px solid rgba(245, 158, 11, 0.35); padding:3px 10px; border-radius:20px;">
                    <span class="dreaths-pulse-dot" style="width:7px; height:7px; border-radius:50%; background:#F59E0B; display:inline-block;"></span>
                    <span style="font-size:11px; font-weight:700; color:#FBBF24; letter-spacing:-0.2px;">
                        실시간 분석 중 (${countText})
                    </span>
                </div>
            `;
        } else if (views.length > 0) {
            statusBadgeHtml = `
                <div style="display:inline-flex; align-items:center; gap:5px; background:rgba(52, 211, 153, 0.1); border:1px solid rgba(52, 211, 153, 0.25); padding:3px 10px; border-radius:20px;">
                    <span style="font-size:11px; line-height:1;">✅</span>
                    <span style="font-size:11px; font-weight:700; color:#34D399; letter-spacing:-0.2px;">
                        최근 게시물 ${views.length}개 분석 완료
                    </span>
                </div>
            `;
        } else {
            statusBadgeHtml = `
                <div style="display:inline-flex; align-items:center; gap:6px; background:rgba(96, 165, 250, 0.12); border:1px solid rgba(96, 165, 250, 0.3); padding:3px 10px; border-radius:20px;">
                    <span class="dreaths-pulse-dot" style="width:7px; height:7px; border-radius:50%; background:#60A5FA; display:inline-block;"></span>
                    <span style="font-size:11px; font-weight:700; color:#93C5FD; letter-spacing:-0.2px;">
                        실시간 데이터 분석 준비 중...
                    </span>
                </div>
            `;
        }

        // ★ 최근 게시물 반응도 추이 차트 (displayedPosts는 위에서 최신 16개를 시간순으로 이미 계산함)
        const chartHtml = postScores.length > 0 ? `
            <div style="${cardBg} border-radius:14px; padding:16px 18px; margin-top:14px; position:relative;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:12px; font-weight:700; color:var(--primary-text, #F1F5F9); letter-spacing:-0.2px;">최근 게시물 반응도 추이</span>
                        <span style="font-size:11px; color:#64748B; font-weight:600;">(최근 ${displayedPosts.length}개)</span>
                    </div>
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span style="display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:800; color:#E11D48; background:rgba(225, 29, 72, 0.08); padding:3px 9px; border-radius:12px; border:1px solid rgba(225, 29, 72, 0.2);">
                            <span>🔥 최고</span> ${maxScore}pt
                        </span>
                        ${isAnalyzing ? `<span style="font-size:11px; color:#F59E0B; font-weight:700;">⚡ 분석 중</span>` : ''}
                    </div>
                </div>

                <!-- 차트 본체 (높이 94px + 그리드라인 + 베이스라인 + 배경 트랙) -->
                <div style="position:relative; height:94px; width:100%; border-bottom:2px solid rgba(148, 163, 184, 0.3); display:flex; align-items:flex-end; justify-content:center; gap:7px; padding-bottom:3px;">
                    <!-- 50% 높이 참조 가이드라인 -->
                    <div style="position:absolute; top:46%; left:0; right:0; border-top:1px dashed rgba(148, 163, 184, 0.22); pointer-events:none; z-index:0;"></div>

                    ${displayedPosts.map((p, i) => {
                        // 반응도 점수 기준 지각적 루트 스케일링
                        const ratio = chartMaxScore > 0 ? (p.score / chartMaxScore) : 0;
                        const heightPct = chartMaxScore > 0 ? Math.round(Math.pow(ratio, 0.45) * 80 + 20) : 20;
                        const isTop = p.score === chartMaxScore;

                        // 확장프로그램 반응도 등급별 컬러 매칭 (최고점이거나 200pt 이상이면 레드 계열)
                        let barBg, barShadow, borderStyle, labelColor;
                        if (isTop || p.score >= 200) {
                            barBg = 'linear-gradient(180deg, #FB7185 0%, #E11D48 100%)';
                            barShadow = '0 2px 8px rgba(225, 29, 72, 0.35)';
                            borderStyle = 'border: 1px solid rgba(225, 29, 72, 0.4);';
                            labelColor = '#E11D48';
                        } else if (p.score >= 120) {
                            barBg = 'linear-gradient(180deg, #FCD34D 0%, #F59E0B 100%)';
                            barShadow = '0 2px 6px rgba(245, 158, 11, 0.25)';
                            borderStyle = 'border: 1px solid rgba(245, 158, 11, 0.35);';
                            labelColor = '#F59E0B';
                        } else if (p.score >= 50) {
                            barBg = 'linear-gradient(180deg, #38BDF8 0%, #2563EB 100%)';
                            barShadow = '0 2px 6px rgba(37, 99, 235, 0.25)';
                            borderStyle = 'border: 1px solid rgba(37, 99, 235, 0.3);';
                            labelColor = '#38BDF8';
                        } else {
                            barBg = 'linear-gradient(180deg, #94A3B8 0%, #64748B 100%)';
                            barShadow = 'none';
                            borderStyle = 'border: 1px solid rgba(148, 163, 184, 0.3);';
                            labelColor = '#94A3B8';
                        }

                        const relTime = formatRelativeTime(p.taken_at, p.datetime);
                        const labelText = isTop ? `🔥 ${p.score}pt` : `${p.score}pt`;
                        const postLink = p.code ? `https://www.threads.net/@${username}/post/${p.code}` : null;
                        const clickAttr = postLink ? `onclick="window.open('${postLink}', '_blank');"` : '';
                        const dateInfo = relTime ? ` · ${relTime}` : '';

                        return `
                        <div class="dreaths-chart-bar-wrap" ${clickAttr}
                            onmouseenter="this.querySelector('.dreaths-bar-label').style.opacity='1'; this.querySelector('.dreaths-bar-label').style.transform='scale(1.12)';"
                            onmouseleave="if (!${isTop}) this.querySelector('.dreaths-bar-label').style.opacity='0'; this.querySelector('.dreaths-bar-label').style.transform='scale(1)';"
                            style="flex:1; max-width:36px; min-width:12px; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; position:relative; z-index:1; cursor:pointer;"
                            title="${relTime ? relTime + ' 게시물' : (i + 1) + '번째'}: 반응도 ${p.score}pt (조회수 ${p.views > 0 ? p.views.toLocaleString() + '회' : '집계중'}${p.likes > 0 ? ' · 좋아요 ' + p.likes.toLocaleString() + '개' : ''}${dateInfo}${postLink ? ' · 클릭 시 열림' : ''})"
                        >
                            <!-- 점수 라벨: 기본은 최고점만 노출, 마우스 오버 시 모든 막대의 pt 점수 선명하게 노출 -->
                            <div class="dreaths-bar-label" style="font-size:${isTop ? '9px' : '8.5px'}; font-weight:${isTop ? '800' : '700'}; color:${labelColor}; margin-bottom:3px; white-space:nowrap; letter-spacing:-0.3px; opacity:${isTop ? '1' : '0'}; transition:opacity 0.15s ease, transform 0.15s ease;">
                                ${labelText}
                            </div>
                            <!-- 배경 트랙(Pillar) 안에 반응도 바를 배치 -->
                            <div style="width:100%; height:100%; max-height:70px; background:rgba(148, 163, 184, 0.12); border-radius:6px; display:flex; flex-direction:column; justify-content:flex-end; overflow:hidden;">
                                <div class="dreaths-bar-inner" style="width:100%; height:${heightPct}%; background:${barBg}; box-shadow:${barShadow}; ${borderStyle} border-radius:5px 5px 2px 2px; transition:filter 0.15s ease;"></div>
                            </div>
                        </div>
                        `;
                    }).join('')}
                </div>

                <!-- 하단 X축 순서 안내 -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px; padding:0 2px; font-size:10px; color:#64748B; font-weight:600;">
                    <span>이전 게시물</span>
                    <span style="font-size:9px; color:#94A3B8;">← 시간 순서 (마우스 오버 시 점수 확인) →</span>
                    <span>최신 게시물</span>
                </div>
            </div>
        ` : `
            <div style="text-align:center; padding:18px; color:#64748B; font-size:12px; font-weight:500; ${cardBg} border-radius:14px; margin-top:14px; display:flex; align-items:center; justify-content:center; gap:8px;">
                <span class="dreaths-pulse-dot" style="width:6px; height:6px; border-radius:50%; background:#60A5FA; display:inline-block;"></span>
                게시물 반응도 지표를 실시간 분석하고 있습니다. 잠시만 기다려주세요...
            </div>
        `;

        // ★ 빨간색으로 표기되는 '터진 게시글' (고반응도/급상승 TOP) 리스트
        let breakoutPostsHtml = '';
        if (breakoutPosts.length > 0) {
            breakoutPostsHtml = `
            <div style="${cardBg} border-radius:14px; padding:15px 18px; margin-top:14px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <div style="display:flex; align-items:center; gap:6px;">
                        <span style="font-size:12px; font-weight:800; color:#E11D48; display:flex; align-items:center; gap:4px;">
                            🔥 터진 게시글 TOP ${breakoutPosts.length}
                        </span>
                        <span style="font-size:11px; color:#64748B; font-weight:600;">(반응도 급상승 & 고성과 게시물)</span>
                    </div>
                    <span style="font-size:10px; color:#94A3B8; font-weight:600;">상세분석 또는 클릭 시 새 탭 이동</span>
                </div>
                <div style="display:flex; flex-direction:column; gap:9px;">
                    ${breakoutPosts.map((p, idx) => {
                        const isRedTier = idx === 0 || p.score === maxScore || p.score >= 200;
                        const rankLabel = idx === 0 ? '1위' : (idx === 1 ? '2위' : '3위');
                        const rankEmoji = idx === 0 ? '🥇' : (idx === 1 ? '🥈' : '🥉');
                        
                        // 빨간색 뱃지 (1위 또는 200pt 이상) vs 앰버 골드 뱃지
                        const badgeStyle = isRedTier
                            ? 'background:linear-gradient(135deg, #FB7185 0%, #E11D48 100%); color:#fff; box-shadow:0 2px 7px rgba(225, 29, 72, 0.4); border:none;'
                            : 'background:rgba(245, 158, 11, 0.15); color:#F59E0B; border:1px solid rgba(245, 158, 11, 0.35);';
                        
                        const itemBorder = isRedTier
                            ? 'border:1px solid rgba(225, 29, 72, 0.35); background:rgba(225, 29, 72, 0.04);'
                            : 'border:1px solid var(--lines-secondary, rgba(125, 125, 125, 0.15)); background:var(--secondary-background, rgba(125, 125, 125, 0.04));';
                        
                        const postUrl = p.code ? `https://www.threads.net/@${username}/post/${p.code}` : '#';
                        const snippet = (p.text || '').replace(/\s+/g, ' ').trim() || '(클릭하여 스레드 본문 확인)';
                        const spreadRatio = (followers > 0 && p.views > 0) ? (p.views / followers) : 0;
                        const relTime = formatRelativeTime(p.taken_at, p.datetime);

                        return `
                        <a href="${postUrl}" target="_blank" rel="noopener noreferrer" class="dreaths-breakout-item" style="
                            display:block; 
                            text-decoration:none; 
                            color:inherit; 
                            ${itemBorder} 
                            border-radius:10px; 
                            padding:11px 14px; 
                            transition:all 0.15s ease;
                            cursor:pointer;
                        ">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:7px; flex-wrap:wrap; gap:6px;">
                                <div style="display:flex; align-items:center; gap:6px;">
                                    <span style="${badgeStyle} font-size:11px; font-weight:800; padding:2.5px 8px; border-radius:6px; letter-spacing:-0.2px; display:inline-flex; align-items:center; gap:3px;">
                                        <span>${rankEmoji} ${rankLabel}</span> ${p.score}pt
                                    </span>
                                    <span style="font-size:10px; color:#94A3B8; background:rgba(148, 163, 184, 0.12); padding:2px 7px; border-radius:4px; font-weight:600;">
                                        ${p.mediaType || '게시물'}
                                    </span>
                                    ${relTime ? `<span style="font-size:10px; color:#64748B;">${relTime}</span>` : ''}
                                </div>
                                <div style="display:flex; align-items:center; gap:8px; font-size:11px; font-weight:700;">
                                    ${p.views > 0 ? `<span style="color:#60A5FA;">👁️ ${formatDashboardNum(p.views)}</span>` : ''}
                                    ${p.likes > 0 ? `<span style="color:#F43F5E;">❤️ ${p.likes.toLocaleString()}</span>` : ''}
                                    ${p.replies > 0 ? `<span style="color:#38BDF8;">💬 ${p.replies.toLocaleString()}</span>` : ''}
                                    ${p.shares > 0 ? `<span style="color:#A78BFA;">🔄 ${p.shares.toLocaleString()}</span>` : ''}
                                    ${spreadRatio >= 2.0 ? `<span style="color:#10B981; background:rgba(16, 185, 129, 0.12); padding:1.5px 6px; border-radius:4px;">🚀 ${spreadRatio.toFixed(1)}배</span>` : ''}
                                    ${p.code ? `
                                        <button class="dreaths-breakout-deep-btn" data-code="${p.code}" title="이 게시물의 메타 알고리즘 8대 시그널을 상세 분석합니다" style="
                                            background:#2563EB;
                                            color:#FFFFFF;
                                            border:1px solid #3B82F6;
                                            border-radius:5px;
                                            padding:2px 7px;
                                            font-size:10px;
                                            font-weight:700;
                                            cursor:pointer;
                                        ">🔍 상세분석</button>
                                    ` : ''}
                                </div>
                            </div>
                            <div style="font-size:12px; line-height:1.5; color:var(--primary-text, #E2E8F0); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; word-break:break-word;">
                                ${snippet}
                            </div>
                        </a>
                        `;
                    }).join('')}
                </div>
            </div>
            `;
        }

        dashEl.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; padding-bottom:12px; border-bottom:1px solid rgba(125,125,125,0.12); flex-wrap:wrap; gap:10px;">
                <div style="display:flex; flex-direction:column; align-items:flex-start; gap:4px;">
                    <span style="background:linear-gradient(135deg, #6366F1, #8B5CF6); color:#fff; font-size:9.5px; font-weight:800; padding:2px 7.5px; border-radius:5px; letter-spacing:0.5px; display:inline-block;">DReaThs INSIGHTS</span>
                    <span style="font-weight:800; font-size:15px; color:var(--primary-text, #F1F5F9); letter-spacing:-0.2px;">@${username} 프로필 분석</span>
                </div>
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                    ${statusBadgeHtml}
                    <button id="dreaths-csv-export-btn" title="게시물 상세 지표를 엑셀(CSV) 파일로 다운로드합니다" style="
                        display:inline-flex; 
                        align-items:center; 
                        gap:5px; 
                        background:rgba(59, 130, 246, 0.12); 
                        color:#38BDF8; 
                        border:1px solid rgba(59, 130, 246, 0.35); 
                        padding:4px 11px; 
                        border-radius:20px; 
                        font-size:11px; 
                        font-weight:700; 
                        cursor:pointer; 
                        transition:all 0.15s ease;
                        letter-spacing:-0.2px;
                    ">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                        <span>엑셀(CSV) 다운로드</span>
                    </button>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:10px;">
                <div style="${cardStyle}">
                    <div style="${cardLabelStyle}">평균 조회수</div>
                    <div style="${cardValStyle} color:#60A5FA;">${views.length > 0 ? formatDashboardNum(avgViews) : '—'}</div>
                </div>
                <div style="${cardStyle}">
                    <div style="${cardLabelStyle}">팔로워</div>
                    <div style="${cardValStyle} color:var(--primary-text, #F1F5F9);">${followers > 0 ? formatDashboardNum(followers) : '—'}</div>
                </div>
                <div style="${cardStyle}">
                    <div style="${cardLabelStyle}">평균 반응도</div>
                    <div style="${cardValStyle} color:#F472B6;">${avgScore > 0 ? avgScore + 'pt' : (avgInteractions > 0 ? formatDashboardNum(avgInteractions) : '—')}</div>
                </div>
                <div style="${cardStyle}">
                    <div style="${cardLabelStyle}">${metric4Label}</div>
                    <div style="${cardValStyle} color:#34D399;">${metric4Val}</div>
                </div>
            </div>

            ${meta5ActionsHtml}
            ${chartHtml}
            ${breakoutPostsHtml}
        `;

        // 터진 게시글 TOP 3 내부의 '🔍 상세분석' 버튼 이벤트 바인딩
        const breakoutDeepBtns = dashEl.querySelectorAll('.dreaths-breakout-deep-btn');
        breakoutDeepBtns.forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const code = btn.getAttribute('data-code');
                const targetP = postScores.find(item => item.code === code) || {};
                openDeepAnalysisModal({
                    postCode: code,
                    author: username,
                    views: targetP.views || 0,
                    likes: targetP.likes || 0,
                    replies: targetP.replies || 0,
                    reposts: targetP.reposts || 0,
                    shares: targetP.shares || 0,
                    followers: followers || 0,
                    timeHours: targetP.timeHours || 24,
                    baseScore: targetP.score || 1
                });
            };
        });

        const exportBtn = dashEl.querySelector('#dreaths-csv-export-btn');
        if (exportBtn) {
            exportBtn.onmouseenter = () => {
                exportBtn.style.background = 'rgba(59, 130, 246, 0.22)';
                exportBtn.style.borderColor = '#38BDF8';
            };
            exportBtn.onmouseleave = () => {
                exportBtn.style.background = 'rgba(59, 130, 246, 0.12)';
                exportBtn.style.borderColor = 'rgba(59, 130, 246, 0.35)';
            };
            exportBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const origHtml = exportBtn.innerHTML;
                exportBtn.innerHTML = `<span>⏳ 추출 중...</span>`;
                exportBtn.style.opacity = '0.7';
                setTimeout(() => {
                    try {
                        exportProfileCsv(username, prof, followers);
                    } finally {
                        exportBtn.innerHTML = origHtml;
                        exportBtn.style.opacity = '1';
                    }
                }, 50);
            };
        }
    };

    setInterval(injectAnalyticsUI, 100);
    setInterval(renderProfileDashboard, 1000);
})();

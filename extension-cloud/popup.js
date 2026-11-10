document.addEventListener('DOMContentLoaded', () => {
    const jwtInput = document.getElementById('jwtInput');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');
    const getKeyBtn = document.getElementById('getKeyBtn');
    const engagementToggle = document.getElementById('engagementToggle');
    const quotaContainer = document.getElementById('quotaContainer');
    const quotaText = document.getElementById('quotaText');
    const quotaBar = document.getElementById('quotaBar');
    const accountText = document.getElementById('accountText');
    const clearKeyBtn = document.getElementById('clearKeyBtn');

    const parseJwtSoId = (token) => {
        if (!token || typeof token !== 'string') return null;
        try {
            const parts = token.split('.');
            if (parts.length < 2) return null;
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(atob(base64));
            return payload && payload.soId ? payload.soId : null;
        } catch (e) {
            return null;
        }
    };

    const updateAccountBadge = (token, verifiedSoId = null) => {
        if (!accountText) return;
        const soId = verifiedSoId || parseJwtSoId(token);
        if (soId) {
            accountText.textContent = `#${soId} 연동됨`;
            accountText.style.color = '#4f46e5';
            if (clearKeyBtn) clearKeyBtn.style.display = 'inline-block';
        } else if (token) {
            accountText.textContent = '연동 키 적용됨';
            accountText.style.color = '#059669';
            if (clearKeyBtn) clearKeyBtn.style.display = 'inline-block';
        } else {
            accountText.textContent = '미연동';
            accountText.style.color = '#6b7280';
            if (clearKeyBtn) clearKeyBtn.style.display = 'none';
        }
    };

    const updateQuotaUI = (count, limit) => {
        if (!quotaContainer || !quotaText || !quotaBar) return;
        quotaContainer.style.display = 'block';
        const safeLimit = limit || 100;
        const safeCount = count !== undefined ? count : 0;
        const percent = Math.min(100, Math.round((safeCount / safeLimit) * 100));

        quotaBar.style.width = `${percent}%`;

        if (safeCount >= safeLimit) {
            quotaText.style.color = '#ef4444';
            quotaText.textContent = `${safeCount} / ${safeLimit}개 (한도 도달)`;
            quotaBar.style.background = '#ef4444';
        } else {
            quotaText.style.color = '#4f46e5';
            quotaText.textContent = `${safeCount} / ${safeLimit}개`;
            quotaBar.style.background = 'linear-gradient(90deg, #4f46e5, #7c3aed)';
        }
    };

    const loadDailyStatus = () => {
        try {
            chrome.runtime.sendMessage({ action: 'GET_DAILY_STATUS' }, (res) => {
                if (chrome.runtime.lastError) return;
                if (res && res.success) {
                    if (res.so_id) {
                        updateAccountBadge(jwtInput.value.trim(), res.so_id);
                    }
                    if (res.today_count !== undefined) {
                        updateQuotaUI(res.today_count, res.daily_limit);
                    }
                }
            });
        } catch (e) {}
    };

    const applySettings = (result) => {
        const token = (result && result.dreaths_jwt) ? result.dreaths_jwt : '';
        jwtInput.value = token;
        updateAccountBadge(token);
        if (token) {
            loadDailyStatus();
        } else if (quotaContainer) {
            quotaContainer.style.display = 'none';
        }
        if (result && result.dreaths_show_engagement !== undefined) {
            engagementToggle.checked = result.dreaths_show_engagement;
        } else {
            engagementToggle.checked = true;
        }
    };

    // Load existing settings: prefer local first (most recently saved), fallback to sync
    chrome.storage.local.get(['dreaths_jwt', 'dreaths_show_engagement'], (localResult) => {
        chrome.storage.local.get(['dreaths_jwt', 'dreaths_show_engagement'], (syncResult) => {
            const localToken = (localResult && localResult.dreaths_jwt) ? localResult.dreaths_jwt.trim() : '';
            const syncToken = (syncResult && syncResult.dreaths_jwt) ? syncResult.dreaths_jwt.trim() : '';
            const mergedToken = localToken || syncToken;

            let mergedShow = true;
            if (localResult && localResult.dreaths_show_engagement !== undefined) {
                mergedShow = localResult.dreaths_show_engagement;
            } else if (syncResult && syncResult.dreaths_show_engagement !== undefined) {
                mergedShow = syncResult.dreaths_show_engagement;
            }

            applySettings({ dreaths_jwt: mergedToken, dreaths_show_engagement: mergedShow });

            if (mergedToken) {
                if (!localToken) {
                    chrome.storage.local.set({ dreaths_jwt: mergedToken, dreaths_show_engagement: mergedShow });
                }
                if (syncToken !== mergedToken) {
                    chrome.storage.local.set({ dreaths_jwt: mergedToken, dreaths_show_engagement: mergedShow });
                }
            }
        });
    });

    if (clearKeyBtn) {
        clearKeyBtn.addEventListener('click', () => {
            jwtInput.value = '';
            updateAccountBadge('');
            if (quotaContainer) quotaContainer.style.display = 'none';
            chrome.storage.local.set({ dreaths_jwt: '' }, () => {
                chrome.storage.local.set({ dreaths_jwt: '' }, () => {
                    statusDiv.textContent = '연동 키가 초기화되었습니다. 새 키를 붙여넣고 Save를 눌러주세요.';
                    jwtInput.focus();
                });
            });
        });
    }

    if (getKeyBtn) {
        getKeyBtn.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://hongthreads.hongsik.blog/dashboard/benchmark' });
        });
    }

    saveBtn.addEventListener('click', () => {
        let token = jwtInput.value.trim();
        // Remove 'Bearer ' prefix, quotes, and extra whitespace if user pasted them
        token = token.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '').trim();
        jwtInput.value = token;
        updateAccountBadge(token);
        const showEngagement = engagementToggle.checked;
        const data = { 
            dreaths_jwt: token,
            dreaths_show_engagement: showEngagement
        };

        // Save to local FIRST (instant), then sync (local device storage)
        chrome.storage.local.set(data, () => {
            chrome.storage.local.set(data, () => {
                const soId = parseJwtSoId(token);
                statusDiv.textContent = soId
                    ? `계정(#${soId}) 키로 변경 및 저장되었습니다! `
                    : '설정이 저장되었습니다! ';
                if (token) {
                    loadDailyStatus();
                } else if (quotaContainer) {
                    quotaContainer.style.display = 'none';
                }
                setTimeout(() => {
                    statusDiv.textContent = '';
                }, 2500);
            });
        });
    });
});

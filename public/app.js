// 로그인 상태 관리
let authCredentials = null;

const loginContainer = document.getElementById('loginContainer');
const mainContainer = document.getElementById('mainContainer');
const loginForm = document.getElementById('loginForm');
const loginError = document.getElementById('loginError');
const logoutBtn = document.getElementById('logoutBtn');

const uploadArea = document.getElementById('uploadArea');
const fileInput = document.getElementById('fileInput');
const loading = document.getElementById('loading');
const results = document.getElementById('results');
const resultsList = document.getElementById('resultsList');
const errorDiv = document.getElementById('error');
const optimizeCheck = document.getElementById('optimizeCheck');
const webpCheck = document.getElementById('webpCheck');
const adCheck = document.getElementById('adCheck');
const limitCheck = document.getElementById('limitCheck');
const limitBadge = document.getElementById('limitBadge');

const API_ENDPOINT = '/api/upload';

const MAX_DIMENSION = 1200;
const QUALITY = 0.85;
const MAX_CANVAS_SIZE = 4096;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

const settingsBtn = document.getElementById('settingsBtn');
const settingsModal = document.getElementById('settingsModal');
const settingsSummary = document.getElementById('settingsSummary');

// 용량 제한 체크박스 토글
limitCheck.addEventListener('change', () => {
    limitBadge.textContent = limitCheck.checked ? '10MB' : '해제됨';
});

// ── 설정 모달 ──
function openSettings() {
    if (typeof settingsModal.showModal === 'function') {
        settingsModal.showModal();
    } else {
        settingsModal.setAttribute('open', ''); // <dialog> 미지원 브라우저 대비
    }
}

function closeSettings() {
    if (typeof settingsModal.close === 'function') settingsModal.close();
    else settingsModal.removeAttribute('open');
}

settingsBtn.addEventListener('click', openSettings);
settingsSummary.addEventListener('click', openSettings);

// 바깥(배경) 클릭 시 닫기
settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
});

// 현재 설정 요약 표시
function updateSettingsSummary() {
    const chips = [];
    if (webpCheck.checked) chips.push('<span class="chip">WebP 변환</span>');
    if (optimizeCheck.checked) chips.push('<span class="chip">최적화 1200px</span>');
    if (adCheck.checked) chips.push('<span class="chip chip-ad">광고 → /ad/</span>');
    chips.push(limitCheck.checked
        ? '<span class="chip">용량 10MB 제한</span>'
        : '<span class="chip chip-warn">용량 제한 해제</span>');
    settingsSummary.innerHTML = `<span class="summary-label">⚙️ 현재 설정</span>${chips.join('')}`;
}

[webpCheck, optimizeCheck, adCheck, limitCheck].forEach((el) => el.addEventListener('change', updateSettingsSummary));
updateSettingsSummary();

// 로그인
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    loginError.style.display = 'none';
    authCredentials = btoa(`${username}:${password}`);
    localStorage.setItem('auth', authCredentials);
    showMainApp();
});

logoutBtn.addEventListener('click', () => {
    authCredentials = null;
    localStorage.removeItem('auth');
    showLoginScreen();
});

function showMainApp() {
    loginContainer.style.display = 'none';
    mainContainer.style.display = 'flex';
}

function showLoginScreen() {
    loginContainer.style.display = 'flex';
    mainContainer.style.display = 'none';
    loginForm.reset();
    loginError.style.display = 'none';
}

window.addEventListener('load', () => {
    const savedAuth = localStorage.getItem('auth');
    if (savedAuth) {
        authCredentials = savedAuth;
        showMainApp();
    } else {
        showLoginScreen();
    }
});

uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

async function handleFiles(files) {
    if (files.length === 0) return;
    errorDiv.style.display = 'none';
    loading.style.display = 'block';
    if (resultsList.children.length === 0) {
        results.style.display = 'none';
    }
    for (const file of files) {
        await processOneFile(file);
        await sleep(300);
    }
    loading.style.display = 'none';
    fileInput.value = '';
}

function getExtension(name) {
    const i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

function replaceExtension(name, ext) {
    const i = name.lastIndexOf('.');
    return (i === -1 ? name : name.slice(0, i)) + '.' + ext;
}

// 일부 OS/브라우저는 AVIF 파일의 MIME 타입을 비워서 넘기므로 확장자로 보완
function getMimeType(file) {
    if (file.type) return file.type;
    const ext = getExtension(file.name);
    const map = { avif: 'image/avif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
    return map[ext] || '';
}

async function processOneFile(file) {
    const mime = getMimeType(file);
    if (!mime.startsWith('image/')) {
        showError(`"${file.name}"은(는) 이미지 파일이 아닙니다.`);
        return;
    }

    // 용량 제한: limitCheck가 체크된 경우에만 10MB 제한 적용
    if (limitCheck.checked && file.size > DEFAULT_MAX_FILE_SIZE) {
        showError(`"${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})\n용량 제한 해제 체크박스를 해제하면 제한 없이 업로드할 수 있습니다.`);
        return;
    }

    try {
        let processedFile = file;
        let wasOptimized = false;
        let wasConverted = false;

        // GIF도 변환 대상 (캔버스에는 첫 프레임만 그려지므로 애니메이션은 제거됨)
        const wantWebp = webpCheck.checked;
        const wantResize = optimizeCheck.checked;
        // 이미 WebP이고 리사이즈도 안 하면 다시 인코딩할 필요 없음
        const needWebpEncode = wantWebp && (mime !== 'image/webp' || wantResize);

        if (wantResize || needWebpEncode) {
            try {
                processedFile = await processImage(file, {
                    resize: wantResize,
                    format: wantWebp ? 'image/webp' : 'image/jpeg'
                });
                wasOptimized = wantResize;
                wasConverted = processedFile.type === 'image/webp' && mime !== 'image/webp';
                const reduction = ((1 - processedFile.size / file.size) * 100).toFixed(1);
                console.log(`[PROCESS_DONE] ${mime} -> ${processedFile.type} ${formatFileSize(file.size)} -> ${formatFileSize(processedFile.size)} (-${reduction}%)`);
            } catch (processError) {
                console.warn(`[PROCESS_FAILED] ${processError.message}, using original`);
                processedFile = file;
            }
        }

        // 원본 그대로 올리는데 MIME 타입이 비어 있으면(AVIF 등) 타입을 채워서 전송
        if (processedFile === file && !file.type && mime) {
            processedFile = new File([file], file.name, { type: mime, lastModified: file.lastModified });
        }

        const isAd = adCheck.checked;
        const result = await uploadFile(processedFile, file.name, wasOptimized, isAd);
        result.converted = wasConverted;
        addResult(result);

    } catch (error) {
        console.error('[UPLOAD_ERROR]', error.message);
        if (error.message.includes('401') || error.message.includes('Authentication')) {
            showError('인증이 만료되었습니다. 다시 로그인해주세요.');
            setTimeout(() => {
                authCredentials = null;
                localStorage.removeItem('auth');
                showLoginScreen();
            }, 2000);
        } else {
            showError(`"${file.name}" 업로드 실패: ${error.message}`);
        }
    }
}

// 이미지 디코딩 (createImageBitmap 우선, 없으면 <img> 사용)
async function decodeImage(file) {
    if ('createImageBitmap' in window) {
        const bitmap = await createImageBitmap(file);
        return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => { try { bitmap.close(); } catch (e) {} } };
    }
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = () => reject(new Error('이미지 로드 실패 (브라우저가 이 형식을 지원하지 않을 수 있음)'));
            el.src = url;
        });
        return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
    } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
    }
}

// 리사이즈 및 포맷 변환 (format: 'image/webp' | 'image/jpeg')
async function processImage(file, { resize, format }) {
    const decoded = await decodeImage(file);
    let canvas = null;
    try {
        let { width, height } = decoded;
        if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
            throw new Error(`이미지가 너무 큽니다 (${width}×${height}px). 최대 ${MAX_CANVAS_SIZE * 2}px`);
        }
        if (resize && (width > MAX_DIMENSION || height > MAX_DIMENSION)) {
            if (width > height) {
                height = Math.round((height * MAX_DIMENSION) / width);
                width = MAX_DIMENSION;
            } else {
                width = Math.round((width * MAX_DIMENSION) / height);
                height = MAX_DIMENSION;
            }
        }

        // WebP는 투명도를 지원하므로 배경을 채우지 않음. JPEG만 흰 배경 적용.
        const keepAlpha = format === 'image/webp';
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d', { alpha: keepAlpha });
        if (!keepAlpha) {
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
        }
        ctx.drawImage(decoded.source, 0, 0, width, height);

        let blob = await canvasToBlob(canvas, format, QUALITY);
        let outType = format;

        // 일부 브라우저(구형 Safari 등)는 WebP 인코딩을 지원하지 않아 PNG로 돌려줌 → JPEG로 대체
        if (format === 'image/webp' && blob.type !== 'image/webp') {
            console.warn('[WEBP_UNSUPPORTED] 이 브라우저는 WebP 인코딩을 지원하지 않아 JPEG로 저장합니다');
            ctx.globalCompositeOperation = 'destination-over';
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, width, height);
            blob = await canvasToBlob(canvas, 'image/jpeg', QUALITY);
            outType = 'image/jpeg';
        }

        const ext = outType === 'image/webp' ? 'webp' : 'jpg';
        return new File([blob], replaceExtension(file.name, ext), { type: outType, lastModified: Date.now() });
    } finally {
        decoded.release();
        if (canvas) { canvas.width = 0; canvas.height = 0; }
    }
}

function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Blob 변환 실패')), type, quality);
    });
}

async function uploadFile(file, originalName, wasOptimized, isAd) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('isAd', isAd ? 'true' : 'false');

    const headers = {};
    if (authCredentials) {
        headers['Authorization'] = `Basic ${authCredentials}`;
    }

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers,
        body: formData
    });

    if (!response.ok) {
        if (response.status === 401) throw new Error('Authentication required (401)');
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();
    return { ...data, originalName, originalSize: file.size, optimized: wasOptimized };
}

function addResult(data) {
    const div = document.createElement('div');
    div.className = 'result-item';

    const optimizedText = (data.converted ? ' 🔄 WebP 변환' : '') + (data.optimized ? ' ✨ 최적화됨' : '');
    const sizeText = data.size ? formatFileSize(data.size) : '';
    const adBadge = data.isAd
        ? `<span class="result-ad-badge">📁 /ad/ 폴더</span>`
        : '';

    div.innerHTML = `
        <div class="result-card">
            <div class="result-img-wrap">
                <img alt="업로드된 이미지" loading="lazy">
            </div>
            <div class="result-actions">
                <div class="result-meta">
                    ${adBadge}
                    <span class="result-filename">${data.filename}${optimizedText}</span>
                    <span class="result-size">${sizeText}</span>
                </div>
                <button class="copy-btn copy-url-btn">
                    🔗 URL 복사
                </button>
                <button class="copy-btn copy-md-btn">
                    📝 마크다운 복사
                </button>
            </div>
        </div>
    `;

    // img src 직접 설정 (innerHTML에 URL 넣으면 특수문자에서 깨짐)
    const img = div.querySelector('img');
    img.src = data.url;
    img.onerror = () => {
        img.style.display = 'none';
        img.parentElement.style.background = '#ddd';
    };

    // 버튼 이벤트 직접 등록
    div.querySelector('.copy-url-btn').addEventListener('click', function() {
        copyText(data.url, this, 'URL');
    });
    div.querySelector('.copy-md-btn').addEventListener('click', function() {
        copyText(data.markdown, this, '마크다운');
    });

    resultsList.insertBefore(div, resultsList.firstChild);
    results.style.display = 'block';
}

function copyText(text, button, type) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = `✅ ${type} 복사됨!`;
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    }).catch(() => {
        alert('복사에 실패했습니다.');
    });
}

function showError(message) {
    errorDiv.innerHTML = message.replace(/\n/g, '<br>');
    errorDiv.style.display = 'block';
    setTimeout(() => errorDiv.style.display = 'none', 5000);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[APP_READY] FTP Image Uploader');

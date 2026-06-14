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
const adCheck = document.getElementById('adCheck');
const limitCheck = document.getElementById('limitCheck');
const limitBadge = document.getElementById('limitBadge');

const API_ENDPOINT = '/api/upload';

const MAX_DIMENSION = 1200;
const QUALITY = 0.85;
const MAX_CANVAS_SIZE = 4096;
const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// 용량 제한 체크박스 토글
limitCheck.addEventListener('change', () => {
    limitBadge.textContent = limitCheck.checked ? '10MB' : '해제됨';
});

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

async function processOneFile(file) {
    if (!file.type.startsWith('image/')) {
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

        if (optimizeCheck.checked) {
            try {
                processedFile = await optimizeImageSafely(file);
                wasOptimized = true;
                const reduction = ((1 - processedFile.size / file.size) * 100).toFixed(1);
                console.log(`[OPTIMIZE_DONE] ${formatFileSize(file.size)} -> ${formatFileSize(processedFile.size)} (-${reduction}%)`);
            } catch (optimizeError) {
                console.warn(`[OPTIMIZE_FAILED] ${optimizeError.message}, using original`);
            }
        }

        const isAd = adCheck.checked;
        const result = await uploadFile(processedFile, file.name, wasOptimized, isAd);
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

async function optimizeImageSafely(file) {
    if ('createImageBitmap' in window) {
        return await optimizeWithImageBitmap(file);
    } else {
        return await optimizeWithImage(file);
    }
}

async function optimizeWithImageBitmap(file) {
    let bitmap = null;
    let canvas = null;
    let ctx = null;
    try {
        bitmap = await createImageBitmap(file);
        let width = bitmap.width;
        let height = bitmap.height;
        if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
            throw new Error(`이미지가 너무 큽니다 (${width}×${height}px). 최대 ${MAX_CANVAS_SIZE * 2}px`);
        }
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
            if (width > height) {
                height = Math.round((height * MAX_DIMENSION) / width);
                width = MAX_DIMENSION;
            } else {
                width = Math.round((width * MAX_DIMENSION) / height);
                height = MAX_DIMENSION;
            }
        }
        canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise((resolve, reject) => {
            canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Blob 변환 실패')), 'image/jpeg', QUALITY);
        });
        return new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
        if (bitmap) { try { bitmap.close(); } catch(e) {} }
        if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
        ctx = null;
        bitmap = null;
        if (window.gc) window.gc();
    }
}

async function optimizeWithImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let canvas = null;
        let ctx = null;
        const cleanup = () => {
            if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
            if (img.src) URL.revokeObjectURL(img.src);
            ctx = null;
            img.onload = null;
            img.onerror = null;
        };
        img.onload = () => {
            try {
                let width = img.width;
                let height = img.height;
                if (width > MAX_CANVAS_SIZE * 2 || height > MAX_CANVAS_SIZE * 2) {
                    cleanup();
                    reject(new Error(`이미지가 너무 큽니다 (${width}×${height}px)`));
                    return;
                }
                if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
                    if (width > height) {
                        height = Math.round((height * MAX_DIMENSION) / width);
                        width = MAX_DIMENSION;
                    } else {
                        width = Math.round((width * MAX_DIMENSION) / height);
                        height = MAX_DIMENSION;
                    }
                }
                canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                ctx = canvas.getContext('2d', { alpha: false });
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob((blob) => {
                    if (blob) {
                        const f = new File([blob], file.name, { type: 'image/jpeg', lastModified: Date.now() });
                        cleanup();
                        resolve(f);
                    } else {
                        cleanup();
                        reject(new Error('Blob 변환 실패'));
                    }
                }, 'image/jpeg', QUALITY);
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        img.onerror = () => { cleanup(); reject(new Error('이미지 로드 실패')); };
        img.src = URL.createObjectURL(file);
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

    const optimizedText = data.optimized ? ' ✨ 최적화됨' : '';
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

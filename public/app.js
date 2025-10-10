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

const API_ENDPOINT = '/api/upload';

// 기본 최적화 설정
const MAX_DIMENSION = 1200;
const QUALITY = 0.85;

// 메모리 안전 설정
const MAX_CANVAS_SIZE = 4096;
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// 로그인 폼 제출
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    loginError.style.display = 'none';
    
    try {
        // 인증 정보 임시 저장
        const testCredentials = btoa(`${username}:${password}`);
        
        // 실제 업로드 시도 없이 인증만 테스트
        // multipart/form-data 없이 POST 요청
        const verifyResponse = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${testCredentials}`
            }
        });
        
        // 401 = 인증 실패
        if (verifyResponse.status === 401) {
            throw new Error('잘못된 사용자 이름 또는 비밀번호입니다.');
        }
        
        // 400 = 인증 성공했지만 파일이 없음 (정상)
        // 200 = 모두 성공 (있을 수 없지만 허용)
        if (verifyResponse.status === 400 || verifyResponse.status === 200) {
            console.log('[LOGIN_SUCCESS]');
            authCredentials = testCredentials;
            localStorage.setItem('auth', authCredentials);
            showMainApp();
            return;
        }
        
        // 500 등 기타 에러
        const errorData = await verifyResponse.json().catch(() => ({}));
        throw new Error(errorData.error || '로그인 중 오류가 발생했습니다.');
        
    } catch (error) {
        console.error('[LOGIN_ERROR]', error.message);
        authCredentials = null;
        loginError.textContent = error.message || '로그인에 실패했습니다.';
        loginError.style.display = 'block';
    }
});

// 로그아웃
logoutBtn.addEventListener('click', () => {
    authCredentials = null;
    localStorage.removeItem('auth');
    showLoginScreen();
});

// 메인 앱 표시
function showMainApp() {
    loginContainer.style.display = 'none';
    mainContainer.style.display = 'flex';
}

// 로그인 화면 표시
function showLoginScreen() {
    loginContainer.style.display = 'flex';
    mainContainer.style.display = 'none';
    loginForm.reset();
    loginError.style.display = 'none';
}

// 페이지 로드 시 세션 확인
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
        // GC가 메모리를 정리할 시간 제공 (특히 대용량 파일)
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

    if (file.size > MAX_FILE_SIZE) {
        showError(`"${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})`);
        return;
    }

    try {
        console.log(`[PROCESS_START] ${file.name} (${formatFileSize(file.size)})`);
        
        let processedFile = file;
        let wasOptimized = false;
        
        if (optimizeCheck.checked) {
            console.log(`[OPTIMIZE_START] ${file.name}`);
            
            try {
                processedFile = await optimizeImageSafely(file);
                wasOptimized = true;
                
                const reduction = ((1 - processedFile.size / file.size) * 100).toFixed(1);
                console.log(`[OPTIMIZE_DONE] ${formatFileSize(file.size)} -> ${formatFileSize(processedFile.size)} (-${reduction}%)`);
            } catch (optimizeError) {
                console.warn(`[OPTIMIZE_FAILED] ${optimizeError.message}, using original`);
            }
        }
        
        const result = await uploadFile(processedFile, file.name, wasOptimized);
        addResult(result);
        
    } catch (error) {
        console.error('[UPLOAD_ERROR]', error.message);
        
        // 401 에러면 로그아웃
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
    const useBitmap = 'createImageBitmap' in window;
    
    if (useBitmap) {
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
        ctx = canvas.getContext('2d', { 
            alpha: false,
            desynchronized: true
        });
        
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0, width, height);
        
        const blob = await new Promise((resolve, reject) => {
            try {
                canvas.toBlob(
                    (b) => {
                        if (b) {
                            resolve(b);
                        } else {
                            reject(new Error('Blob 변환 실패'));
                        }
                    },
                    'image/jpeg',
                    QUALITY
                );
            } catch (err) {
                reject(err);
            }
        });
        
        const optimizedFile = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: Date.now()
        });
        
        return optimizedFile;
        
    } catch (error) {
        throw error;
    } finally {
        // 메모리 정리 강화
        if (bitmap) {
            try {
                bitmap.close();
            } catch (e) {
                console.warn('[BITMAP_CLOSE_ERROR]', e);
            }
        }
        if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
            canvas = null;
        }
        if (ctx) {
            ctx = null;
        }
        bitmap = null;
        
        // 명시적 GC 힌트 (일부 브라우저에서만 작동)
        if (window.gc) {
            window.gc();
        }
    }
}

async function optimizeWithImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        let canvas = null;
        let ctx = null;
        
        const cleanup = () => {
            if (canvas) {
                canvas.width = 0;
                canvas.height = 0;
                canvas = null;
            }
            if (img.src) {
                URL.revokeObjectURL(img.src);
            }
            if (ctx) {
                ctx = null;
            }
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
                
                canvas.toBlob(
                    (blob) => {
                        if (blob) {
                            const optimizedFile = new File([blob], file.name, {
                                type: 'image/jpeg',
                                lastModified: Date.now()
                            });
                            cleanup();
                            resolve(optimizedFile);
                        } else {
                            cleanup();
                            reject(new Error('Blob 변환 실패'));
                        }
                    },
                    'image/jpeg',
                    QUALITY
                );
                
            } catch (error) {
                cleanup();
                reject(error);
            }
        };
        
        img.onerror = () => {
            cleanup();
            reject(new Error('이미지 로드 실패'));
        };
        
        img.src = URL.createObjectURL(file);
    });
}

async function uploadFile(file, originalName, wasOptimized) {
    const formData = new FormData();
    formData.append('file', file);

    const headers = {};
    if (authCredentials) {
        headers['Authorization'] = `Basic ${authCredentials}`;
    }

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        headers: headers,
        body: formData
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Authentication required (401)');
        }
        
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
    }

    const data = await response.json();
    return {
        ...data,
        originalName: originalName,
        originalSize: file.size,
        optimized: wasOptimized
    };
}

function addResult(data) {
    const div = document.createElement('div');
    div.className = 'result-item';
    
    const optimizedText = data.optimized ? ' ✨ 최적화됨' : '';
    const sizeText = data.size ? formatFileSize(data.size) : '';
    
    div.innerHTML = `
        <div class="result-preview">
            <img src="${data.url}" alt="Uploaded image" loading="lazy" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22%3E이미지%3C/text%3E%3C/svg%3E'">
            <div class="result-info">
                <h4>${data.filename}${optimizedText}</h4>
                <div class="file-size">크기: ${sizeText}</div>
            </div>
        </div>

        <div class="url-box">
            <label>이미지 URL:</label>
            <div class="url-text">${data.url}</div>
        </div>

        <div class="url-box">
            <label>마크다운:</label>
            <div class="url-text">${data.markdown}</div>
        </div>

        <div class="button-group">
            <button class="copy-btn" onclick="copyText('${escapeQuotes(data.url)}', this, 'URL')">
                📋 URL 복사
            </button>
            <button class="copy-btn" onclick="copyText('${escapeQuotes(data.markdown)}', this, '마크다운')">
                📝 마크다운 복사
            </button>
        </div>
    `;
    
    resultsList.insertBefore(div, resultsList.firstChild);
    results.style.display = 'block';
}

window.copyText = function(text, button, type) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = button.textContent;
        button.textContent = `✅ ${type} 복사됨!`;
        button.classList.add('copied');
        
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    }).catch(err => {
        console.error('[COPY_ERROR]', err);
        alert('복사에 실패했습니다.');
    });
}

function showError(message) {
    errorDiv.textContent = message;
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

function escapeQuotes(str) {
    return str.replace(/'/g, "\\'");
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

console.log('[APP_READY] FTP Image Uploader (Memory Safe Mode)');
console.log(`[CONFIG] Max dimension: ${MAX_DIMENSION}px, Quality: ${Math.round(QUALITY * 100)}%`);
console.log(`[FEATURE] createImageBitmap: ${('createImageBitmap' in window) ? 'Yes' : 'No (Fallback)'}`);
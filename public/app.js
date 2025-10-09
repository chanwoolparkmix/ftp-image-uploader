// DOM 요소
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

// 페이지 로드 시 로그인 상태 확인
window.addEventListener('DOMContentLoaded', () => {
    checkLoginStatus();
});

// 로그인 상태 확인
function checkLoginStatus() {
    const auth = localStorage.getItem('authToken');
    
    if (auth) {
        // 로그인되어 있으면 메인 화면 표시
        showMainContainer();
    } else {
        // 로그인되어 있지 않으면 로그인 화면 표시
        showLoginContainer();
    }
}

// 로그인 화면 표시
function showLoginContainer() {
    loginContainer.style.display = 'flex';
    mainContainer.style.display = 'none';
}

// 메인 화면 표시
function showMainContainer() {
    loginContainer.style.display = 'none';
    mainContainer.style.display = 'flex';
}

// 로그인 처리
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    // Base64 인코딩
    const authToken = btoa(`${username}:${password}`);
    
    // 로그인 확인을 위해 테스트 요청
    try {
        const testResponse = await fetch(API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${authToken}`
            },
            body: new FormData() // 빈 폼데이터 (테스트용)
        });
        
        // 401이 아니면 로그인 성공 (400 에러는 파일이 없어서 발생)
        if (testResponse.status === 401) {
            showLoginError('사용자 이름 또는 비밀번호가 올바르지 않습니다.');
            return;
        }
        
        // 로그인 성공
        localStorage.setItem('authToken', authToken);
        hideLoginError();
        showMainContainer();
        
    } catch (error) {
        showLoginError('로그인 중 오류가 발생했습니다.');
        console.error('Login error:', error);
    }
});

// 로그아웃 처리
logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('authToken');
    // 결과 초기화
    results.style.display = 'none';
    resultsList.innerHTML = '';
    errorDiv.style.display = 'none';
    // 로그인 폼 초기화
    loginForm.reset();
    showLoginContainer();
});

// 로그인 에러 표시
function showLoginError(message) {
    loginError.textContent = message;
    loginError.style.display = 'block';
}

// 로그인 에러 숨김
function hideLoginError() {
    loginError.style.display = 'none';
}

// 업로드 영역 클릭
uploadArea.addEventListener('click', () => fileInput.click());

// 드래그 앤 드롭
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

// 파일 처리
async function handleFiles(files) {
    if (files.length === 0) return;

    errorDiv.style.display = 'none';
    loading.style.display = 'block';
    results.style.display = 'none';
    resultsList.innerHTML = '';

    const uploadResults = [];

    for (const file of files) {
        if (!file.type.startsWith('image/')) {
            showError(`❌ "${file.name}"은(는) 이미지 파일이 아닙니다.`);
            continue;
        }

        if (file.size > 10 * 1024 * 1024) {
            showError(`❌ "${file.name}"의 크기가 10MB를 초과합니다. (${formatFileSize(file.size)})`);
            continue;
        }

        try {
            console.log(`업로드 시작: ${file.name}`);
            const result = await uploadFile(file);
            uploadResults.push(result);
        } catch (error) {
            console.error('Upload error:', error);
            
            // 401 에러 시 로그아웃 처리
            if (error.message.includes('401')) {
                alert('세션이 만료되었습니다. 다시 로그인해주세요.');
                localStorage.removeItem('authToken');
                showLoginContainer();
                return;
            }
            
            showError(`❌ "${file.name}" 업로드 실패: ${error.message}`);
        }
    }

    loading.style.display = 'none';

    if (uploadResults.length > 0) {
        results.style.display = 'block';
        uploadResults.forEach(result => addResult(result));
    }

    fileInput.value = '';
}

// 파일 업로드
async function uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('optimize', optimizeCheck.checked);

    const authToken = localStorage.getItem('authToken');
    const headers = {
        'Authorization': `Basic ${authToken}`
    };

    const response = await fetch(API_ENDPOINT, {
        method: 'POST',
        body: formData,
        headers
    });

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('401 Unauthorized');
        }
        const error = await response.json();
        throw new Error(error.error || error.details || 'Upload failed');
    }

    const data = await response.json();
    return {
        ...data,
        originalName: file.name,
        originalSize: file.size
    };
}

// 결과 추가
function addResult(data) {
    const div = document.createElement('div');
    div.className = 'result-item';
    
    const optimizedText = data.optimized ? ' ✨ 최적화됨' : '';
    const sizeText = data.size ? formatFileSize(data.size) : '';
    
    div.innerHTML = `
        <div class="result-preview">
            <img src="${data.url}" alt="Uploaded image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%22 height=%22100%22%3E%3Crect fill=%22%23ddd%22 width=%22100%22 height=%22100%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dy=%22.3em%22 fill=%22%23999%22%3E이미지%3C/text%3E%3C/svg%3E'">
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
    
    resultsList.appendChild(div);
}

// 텍스트 복사
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
        console.error('복사 실패:', err);
        alert('복사에 실패했습니다.');
    });
}

// 에러 표시
function showError(message) {
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    loading.style.display = 'none';
}

// 파일 크기 포맷
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// 따옴표 이스케이프
function escapeQuotes(str) {
    return str.replace(/'/g, "\\'");
}

console.log('🚀 FTP Image Uploader 준비 완료!');
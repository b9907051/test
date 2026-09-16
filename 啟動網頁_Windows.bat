@echo off
chcp 65001 >nul
REM 雙擊這個檔案就會啟動網頁。關掉這個視窗即可停止。
cd /d "%~dp0"

set "PY="
where python >nul 2>&1 && set "PY=python"
if not defined PY where py >nul 2>&1 && set "PY=py"
if not defined PY goto nopython

echo ====================================================
echo  AI 算力租賃價格追蹤
echo  網址: http://localhost:8000
echo  瀏覽器會自動打開。要停止請直接關掉這個視窗。
echo ====================================================
start "" http://localhost:8000
%PY% -m http.server 8000
goto end

:nopython
echo 找不到 Python。
echo 請到 https://www.python.org/downloads/ 下載安裝，
echo 安裝時務必勾選 "Add Python to PATH"，然後重新雙擊這個檔案。
pause

:end

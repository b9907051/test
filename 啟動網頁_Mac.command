#!/bin/bash
# 雙擊這個檔案就會啟動網頁。關掉這個視窗即可停止。
cd "$(dirname "$0")" || exit 1

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "找不到 Python。"
  echo "請到 https://www.python.org/downloads/ 下載安裝，再重新雙擊這個檔案。"
  read -r -p "按 Enter 關閉…" _
  exit 1
fi

# 找一個沒被占用的連接埠
PORT=$("$PY" - <<'PYEOF'
import socket
for p in range(8000, 8100):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        continue
    finally:
        s.close()
PYEOF
)
[ -z "$PORT" ] && PORT=8000

echo "===================================================="
echo " AI 算力租賃價格追蹤"
echo " 網址： http://localhost:$PORT"
echo " 瀏覽器會自動打開。要停止請直接關掉這個視窗。"
echo "===================================================="

( sleep 1; open "http://localhost:$PORT" >/dev/null 2>&1 ) &
"$PY" -m http.server "$PORT"

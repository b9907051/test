# AI 算力租賃價格追蹤（GPU / XPU Rental Price Tracker）

> **第一次使用？** 請先看 **[使用指南.md](使用指南.md)** — 不需要任何程式基礎，照著點就能跑起來。

追蹤主流 AI 加速器（NVIDIA H100 / H200 / B200 / A100 / L40S / RTX 4090 / RTX 5090、AMD MI300X / MI325X / MI355X、Intel Gaudi 3、Google TPU v5p / v6e、AWS Trainium2）在公有雲、AI 專用雲與 GPU 市集的**每顆加速器每小時租賃價格**及其變化。

純靜態網頁（無框架、無第三方套件）＋ Python 收集器 ＋ GitHub Actions 每日排程，直接部署到 GitHub Pages。

## 功能

- **關鍵指標**：AI 算力價格指數（籃子幾何平均、基期 = 100）、H100 中位數與最低價、30 日變動最大的機型，附走勢 sparkline。
- **價格走勢**：最多 6 款加速器同時比較，每點為所有供應商的中位數；十字游標 tooltip、圖例可點擊隱藏。
- **供應商比較**：選一款加速器，看各家最新報價由低至高排序，最便宜者強調顯示，tooltip 顯示 30 日變動與來源。
- **性價比**：$ / PFLOP·hr（FP16 密集算力）與 $ / GB·hr（記憶體）。
- **價格矩陣**：加速器 × 供應商熱力圖，每列以相對價格著色，粗框為最低價。
- **最新報價明細**：可排序表格、7 日 / 30 日變動，並可匯出 CSV（最新報價或完整歷史）。
- 隨需 / 競價切換、30 天～全部的時間區間、USD / TWD（自訂匯率）、深淺色主題、手機版排版。

## 市場基準指數（第三方）

除了各供應商牌價，儀表板另有「市場基準指數比較」區塊，把本站中位數與業界指數疊在同一張圖，並列出 7 / 30 日變動與「本站 vs 指數」溢價：

| 指數 | 發布者 | 性質 | 取得方式 | 收集器 |
|---|---|---|---|---|
| Computable GPU Index (CGI) | Computable | 固定 29 家面板牌價、四分位間投票平均、開源可重算 | 開放 flat files / REST，無需金鑰（資料 CC BY-NC 4.0） | `cgi` 自動 |
| Ornn Compute Price Index (OCPI) | Ornn | 實際成交的成交量加權平均，Bloomberg / ICE 期貨參考 | 免費層：最新值 + 3 個月、5 款 GPU，無需金鑰 | `ocpi` 自動 |
| Silicon Data Rental Index (SDH100RT 等) | Silicon Data | 30+ 來源、每日 350 萬筆觀測 | 僅 Plus / Professional 訂閱者 API | `sdh`（需帳密） |
| AxonIndex GCI | AxonIndex | 20+ 供應商、7 區域、流動性加權每日定盤 | 未見公開 API | 人工登錄 `data/index_manual.json` |

```bash
python3 scripts/collect_indices.py                 # cgi + ocpi（免費）+ 人工登錄
python3 scripts/collect_indices.py --only cgi --days 30 --dry-run
```

端點與 GPU 名稱對應都在 `data/index_sources.json`，若對方 API 路徑調整，改設定即可。第一次在有網路的環境執行前，這些 adapter 尚未經真實 API 驗證；若某來源失敗，log 會指出是哪個路徑，請對照對方文件修改設定。

## 目錄結構

```
index.html               儀表板
assets/style.css, app.js 樣式與邏輯（自製 SVG 圖表）
data/catalog.json        加速器規格（記憶體、FP16 TFLOPS、各平台名稱對應）與供應商清單
data/prices.json         價格歷史：rows = [date, provider, gpu, type, usd, source]
data/list_prices.json    人工維護的公開定價（公有雲等沒有報價 API 的來源）
data/index_sources.json  第三方指數來源設定（端點、GPU 對應、授權說明）
data/indices.json        指數歷史：rows = [date, index, gpu, value, source]
data/index_manual.json   人工登錄的指數值（AxonIndex 等）
scripts/collect_indices.py 收集第三方指數
scripts/seed_demo_indices.py 產生示範指數資料
scripts/collect.py       收集今日報價並寫入 prices.json
scripts/seed_demo_data.py 產生示範資料（合成，非真實報價）
.github/workflows/update-prices.yml 每日收集 + 部署 GitHub Pages
```

## 本地執行

```bash
python3 -m http.server 8000     # 需透過 HTTP 開啟，file:// 會被瀏覽器擋 fetch
# 開啟 http://localhost:8000
```

目前 `data/prices.json` 是**示範資料**（頁面上方會顯示黃色提示）。第一次執行收集器成功後會自動清除示範資料並換成真實報價：

```bash
export RUNPOD_API_KEY=...   # 選填，RunPod 公開查詢通常不需要
export LAMBDA_API_KEY=...   # Lambda 需要 API key
python3 scripts/collect.py            # 全部來源
python3 scripts/collect.py --only vast,list --dry-run   # 只跑部分來源、不寫檔
```

### 資料來源

| 來源 | 方式 | 需要 key |
|---|---|---|
| Vast.ai | 公開市集搜尋 API，取最便宜五分之一報價的中位數（隨需 + 競價） | 否 |
| RunPod | 公開 GraphQL `gpuTypes`（secure / community / bid） | 選填 |
| Lambda | `instance-types` API，多卡機型除以卡數 | 是 |
| AWS / GCP / Azure / OCI / CoreWeave / Nebius / Crusoe… | `data/list_prices.json` 人工填寫，填入 `usd` 與 `verified_on` 後每天自動寫入快照 | — |

新增供應商或機型：在 `data/catalog.json` 加一列（`aliases` 對應各平台的 GPU 名稱），或在 `scripts/collect.py` 的 `ADAPTERS` 加一個回傳 `(gpu_id, type, provider, usd)` 的函式。

## 部署到 GitHub Pages

1. Repo → Settings → Pages → Source 選 **GitHub Actions**。
2. （選填）Settings → Secrets 加入 `RUNPOD_API_KEY`、`LAMBDA_API_KEY`；指數來源可加 `ORNN_API_KEY`（完整歷史）、`SILICONDATA_USERNAME` / `SILICONDATA_PASSWORD`（付費 API）。
3. 合併到 `main` 後 workflow 會在每次 push 與每日 03:17 UTC 執行：收集 → commit `data/prices.json` → 部署。
   也可在 Actions 頁手動 `Run workflow`。

## 方法與限制

- 單位為 USD / 每顆加速器 / 小時；未含預留折扣、承諾用量、網路與儲存費。
- 若某供應商當日沒有快照，最多沿用 14 天前的報價，之後視為無報價。
- 性價比只以廠商標稱規格換算，不代表實際吞吐。
- 價格隨區域、庫存與合約變動，下單前請以供應商頁面為準。

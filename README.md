# 大眾運輸

依手機目前位置，查桃園公車站即時到站，以及回家的公車、台鐵班次。介面為繁體中文，時間皆為 **Asia/Taipei**。這是一個可安裝到主畫面的 PWA，適合放在 GitHub Pages 上靜態託管。

住家座標**不會**寫在原始碼裡（本專案預計公開）。請在「設定」用目前位置、地址搜尋或手動經緯度儲存，資料只留在該瀏覽器的 `localStorage`。

## 本機預覽

```bash
cd transit-web
python3 -m http.server 8080
```

用瀏覽器開啟 <http://localhost:8080/>，並允許定位。台鐵時刻表已預先產生在 `data/`，無需後端。

## GitHub Pages 與 Actions

1. 把本目錄作為 Git 儲存庫的根目錄推上 GitHub（不要只推子資料夾，否則 `.github/workflows/tra.yml` 不會生效）。
2. 在 repo 的 **Settings → Pages**：Source 選 **Deploy from a branch**，分支選 `main`（或你使用的預設分支），資料夾選 `/ (root)`。
3. 確認 Actions 有寫入權限：Settings → Actions → General → Workflow permissions 選 **Read and write**。工作流程本身已宣告 `permissions: contents: write`。
4. 網址會是 `https://<帳號>.github.io/<儲存庫>/`。應用程式全部使用相對路徑（`./data/...`、`./js/...`），在專案站或自訂網域下都可以。

本目錄已含 `.nojekyll`，避免 Jekyll 忽略部分檔案。

### 台鐵時刻表為什麼要預先下載？

桃園 ebus GraphQL（`https://ebus.tycg.gov.tw/ebus/graphql`）回應帶 `Access-Control-Allow-Origin: *`，瀏覽器可直接查即時到站。

台鐵開放資料（車站基本資料、逐日時刻表）**沒有 CORS**，瀏覽器無法直接讀取。因此：

- 應用程式只載入同站的 `./data/tra-stations.json` 與 `./data/tra-YYYYMMDD.json`。
- [`.github/workflows/tra.yml`](.github/workflows/tra.yml) 每天 **00:30 Asia/Taipei**（`16:30 UTC`，台灣無夏令時間）跑一次，也可在 Actions 頁面手動 **Run workflow**。
- 工作流程執行 [`scripts/fetch_tra.py`](scripts/fetch_tra.py)（僅標準函式庫）：從[時刻表清單](https://ods.railway.gov.tw/tra-ods-web/ods/download/dataResource/railway_schedule/JSON/list)解析當日與翌日下載網址，連同車站列表一併精簡後寫入 `data/`（只保留車次、車種、各站到開時刻），若有變更就 commit 並 push，Pages 會跟著更新。超過三天的舊時刻表會刪除。

首次推上 GitHub 時，`data/` 裡已有本機產生的檔案，網站當下就能用；之後靠 Actions 維持新鮮度。若要在本機重抓：

```bash
python3 scripts/fetch_tra.py
```

## 功能

- **附近**：開啟時以高精度定位，列出約 500 公尺內最近 5 個公車站的路線、方向與即時到站；以及 3 公里內台鐵站、各方向接下來 3 班（時刻表）。每 30 秒自動更新，也可按右上角重新整理；狀態列顯示更新時間。
- **回家**：可選「現在出發」、「某時前到家」或「時段到家」。列出最多 3 筆可核實行程：
  - 公車：同一路線在住家約 600 公尺內有較後站序，且**同一輛車**在上車、下車站都有即時 ETA 才列入，趕不上的班次會略過。
  - 台鐵：搭到**住家最近的台鐵站**再步行；若班次不過該站但會停住家附近其他車站，且該站有可核實的即時公車接到住家，才會列出「火車轉公車」（轉乘預留 3 分鐘）。
  - 標示「即時」或「時刻表」。中途站若無即時資料，**不會臆測到達時間**。
- **設定**：用目前位置、Nominatim 地址搜尋，或手動經緯度設定住家。

步行距離 = 直線距離 × 1.3，再以 80 公尺／分鐘無條件進位（至少 1 分）。

## 介面風格

畫面依 [Smartisan OS UI skill](https://github.com/lemonteaau/smartisan-ui-skill)（基於 Smartisan OS 8 / R2 真機校對的非官方 UI Kit）製作：直接引用 kit 的 `smartisan.css`、`smartisan.js` 與圖示 sprite，再以本專案的版面樣式組出 App Bar、分段式底欄、白底圓角列表卡片、細描邊與輕擬物按鈕、即時／時刻表 Chip、Toast。強調色為系統應用使用的低飽和藍，沒有另外混用錘子紅。Smartisan OS 沒有官方暗色模式，因此本應用維持淺色擬物風格，未做自動暗色。

## 限制

- 公車即時資料僅涵蓋桃園 ebus。人在北北基時，附近台鐵時刻仍可用，但沒有台北／新北公車到站。
- ebus 的 `dailySchedule` 多半是起站發車時刻或班距，不是各站時刻。中途站若無即時資料，只標「班表（起站發車）」且不估計本站或到家時間。
- 台鐵為開放資料當日時刻表，不含即時誤點；一天更新一次（可手動觸發工作流程）。若當天檔案尚未產生，會提示時刻表缺失。
- 步行用直線 × 1.3，可能與實際路徑略有出入。
- 同名且座標很近的站牌會合併；馬路對向的同名站牌會分開。
- Nominatim 有使用規範與速率限制，且瀏覽器無法自訂 `User-Agent`，地址搜尋失敗時仍可改填經緯度。
- 加入 iOS 主畫面請用 Safari 的「加入主畫面」；定位權限需在系統與瀏覽器中允許。

## 授權與來源

- 桃園公車 ebus GraphQL、台鐵開放資料、OpenStreetMap Nominatim。
- 介面元件與 token 來自 Smartisan OS UI Kit (Unofficial)，CC BY 4.0；請勿把 kit 品牌標誌用在產品識別上。本應用圖示為自行繪製。

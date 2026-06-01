# Szalo

Web app quan ly Zalo ca nhan dua tren `zca-js`.

## Tinh nang

- Dang nhap bang QR Zalo Web qua `zca-js`.
- Luu session vao `.zalo-manager/session.json` de tu khoi phuc lan sau.
- Realtime listener cho tin nhan, typing, seen/delivered, friend event, group event.
- Dong bo danh ba va danh sach nhom.
- Chat 1-1 va group.
- Gui tin nhan text va gui nhieu file dinh kem.
- Toast trong app va browser notification cho tin nhan moi.

## Chay local

```powershell
npm install
npm run dev
```

Mac dinh:

- Web: http://localhost:5173
- API: http://localhost:4010

Neu muon chay tung phan:

```powershell
npm run dev:server
npm run dev:web
```

## Chay mot server sau build

```powershell
npm run build
npm start
```

Sau build, Express phuc vu ca web app va API tai:

- App + API: http://localhost:4010

Ban build production duoc ghi vao `build/` va thu muc nay da duoc gitignore.

Co the doi port bang bien moi truong:

```powershell
$env:PORT=4020
npm start
```

Trong production build, frontend goi API theo same-origin, nen doi `PORT` van dung. Khi chay dev bang Vite rieng, frontend mac dinh goi API `http://localhost:4010`; neu doi port API trong dev thi dat them `VITE_API_URL`.

## Luu y an toan

`zca-js` la API khong chinh thuc, mo phong Zalo Web. Hay dung tai khoan test, tranh spam, va khong commit thu muc `.zalo-manager` vi co cookie/session dang nhap.

## Kiem tra

```powershell
npm run lint
npm run build
npm run smoke
```

`npm run smoke` can kiem tra server dang chay. Mac dinh no goi `http://localhost:4010`; neu dung port khac:

```powershell
$env:SMOKE_BASE_URL="http://localhost:4020"
npm run smoke
```

## Dang nhap lai khi session het han

Neu `/api/health` hoac `npm run smoke` bao `offline` voi loi `Dang nhap that bai`, session Zalo Web da het han.

1. Mo http://localhost:4010
2. Bam `Tao QR moi`
3. Quet QR bang app Zalo
4. Doi trang thai chuyen sang `Online`
5. Bam `Dong bo` neu can cap nhat danh ba/nhom

Kiem tra nhanh sau khi quet:

```powershell
npm run smoke
```

De xac nhan end-to-end, chon mot chat hoac group test trong UI, gui mot tin text ngan va mot file nho. Neu ben nhan thay tin/file hoac UI nhan lai realtime event thi luong live da dat.

# 38-0 — Anadolu Efes Efsane Kadro Simülasyonu

Anadolu Efes'in 1995'ten bugüne EuroLeague ve BSL tarihinden bir kadro kurup
38 maçlık bir sezonu yenilgisiz bitirip bitiremeyeceğini simüle eden,
tamamen statik (sunucu gerektirmeyen) bir tarayıcı oyunu.

## Dosya yapısı

```
index.html      Sayfa iskeleti
style.css       Görsel kimlik (skorboard/tribün teması)
app.js          Oyun motoru: taslak, koç seçimi, simülasyon
data/
  euroleague_efes_2002_2026.json   EuroLeague oyuncu-sezon verisi (RealGM)
  bsl_efes_1995_2026.json          BSL oyuncu-sezon verisi (TBLStat.net)
  coaches.json                     Koç listesi ve oyun-içi katkı puanları
  coach_by_season.json             Referans: sezon → baş antrenör
```

Bağımlılık yok, derleme adımı yok — düz HTML/CSS/JS. Herhangi bir statik
barındırma (GitHub Pages, Netlify, vs.) üzerinde doğrudan çalışır.

## Yerelde çalıştırma

Tarayıcılar `fetch()` ile yerel dosyaları doğrudan açmayı (file://) engellediği
için basit bir yerel sunucu gerekir:

```
python3 -m http.server 8000
```

sonra `http://localhost:8000` adresini aç.

Bağımsız, taraftar yapımı bir projedir; Anadolu Efes veya EuroLeague ile
resmi bir bağlantısı yoktur.

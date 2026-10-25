# Rocket Clash Companion

[Rocket Clash](https://rocket.loopesports.com) turnuvaları için Windows masaüstü uygulaması.
Rocket League'in **resmî İstatistik API'sini** dinler ve maç sonuçlarını turnuva sunucusuna iletir.

Bu depo uygulamanın **tüm kaynak kodudur**. İndirmeden önce kendin okuyabilir ya da bir yapay zekâya
(ChatGPT, Claude, Gemini vb.) verip inceletebilirsin.

## Ne yapar?

1. Rocket League açıkken `127.0.0.1:49123` adresine (yalnızca bu bilgisayar) bağlanır ve oyunun resmî İstatistik API'sinden gelen veriyi okur. → `main.cjs`
2. Oyunun istatistik ayar dosyasını (`Documents\My Games\Rocket League\TAGame\Config\TAStatsAPI.ini`) yoksa oluşturur, eksik satırları ekler. Başka dosyaya dokunmaz. → `main.cjs` (`enableOfficialStatsAPI`)
3. Oyunun açık olup olmadığını `tasklist` ile bakar (yalnızca bilgi amaçlı). → `main.cjs` (`pollRocketLeagueProcess`)
4. Giriş yaptığın hesapla maç başladı/bitti bildirimini ve maç sonucunu turnuva sunucusuna gönderir. → `src/App.jsx` (`apiCall`)

## Ne yapmaz?

- Oyunun belleğini okumaz, oyun dosyalarını değiştirmez, oyuna kod enjekte etmez.
- Maç verisini tek bir sunucu adresine gönderir (`BACKEND_URL`, `src/App.jsx`). Giriş için ayrıca Firebase kimlik doğrulama (Google) hizmetini kullanır. Başka bir yere veri göndermez.
- Google ile girişte tarayıcı kimlik bilgisini yalnızca bu bilgisayardaki geçici, tek kullanımlık yerel adrese iletir. → `main.cjs` (`SITE_LOGIN_URL` ve altı)

> Not: Firebase `apiKey` değeri `src/firebase.js` içinde görünür. Bu bir web istemci anahtarıdır, tasarım gereği
> herkese açıktır ve gizli değildir. Asıl yetki kontrolü sunucudadır.

## Kendin derle

Gereken: [Node.js](https://nodejs.org) 20 veya üstü, Windows.

```bash
npm install
npm run dev     # geliştirme modu (Vite + Electron)
npm run make    # kurulum dosyası üretir (release/ klasörüne)
```

İsteğe bağlı ayarlar için `.env.example` dosyasına bak.

## Windows "Bilinmeyen Yayıncı" uyarısı

Uygulama kod imzalama sertifikasına sahip değildir. Bu yüzden Windows SmartScreen uyarı verebilir:
**Ek Bilgi → Yine de Çalıştır**. Güvenmiyorsan yukarıdaki gibi kodu okuyup kendin derleyebilirsin.

## Güvenlik sorunu bulursan

Bir açık ya da şüpheli bir davranış görürsen GitHub'da **Issues** sekmesinden bildir.

## Lisans

[MIT](LICENSE)

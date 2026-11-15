# Kabar

Kotak pesan & notifikasi pribadi bergaya chat — seperti Telegram, tapi milik Anda sendiri.
Skrip, server, bot, GitHub Actions, atau aplikasi lain (mis. [Radar Saham US](https://github.com/GabFx09/radar-saham-us))
mengirim pesan ke **saluran**; setiap saluran tampil sebagai chat, lengkap dengan notifikasi push di HP/laptop.

**Aplikasi:** https://gabfx09.github.io/kabar/ — bisa dipasang ke layar utama (PWA).

- Tanpa server sendiri: pesan disimpan di **gist rahasia** milik Anda; notifikasi dikirim dengan Web Push (VAPID).
- Chat per saluran, pesan belum dibaca, sematkan, bisukan, cari, "Catatan Saya" untuk catatan pribadi.
- Pesan prioritas **tinggi** tetap berbunyi walau saluran dibisukan atau sedang **jam tenang**.
- Tampilan bergaya terminal; ketik `/bantuan` di chat untuk perintah (`/cari`, `/bisukan`, `/hapus`, `/tema` …).
- Status dibaca tersinkron antar perangkat; tekan lama sebuah pesan untuk salin/hapus.
- **Enkripsi end-to-end** (AES-256-GCM + PBKDF2): aktifkan di Setelan; pengirim memakai `KABAR_KUNCI`.
- **Tombol aksi** di pesan, dan skrip pengirim bisa menunggu jawabannya (`tunggu_jawaban`).
- **Gambar** (URL atau berkas ≤ 600 KB, ikut terenkripsi bila enkripsi aktif).
- **Pengingat terjadwal** dari chat: `/ingatkan besok 08:00 bayar tagihan`, `/ingatkan setiap senin 09:00 rapat`, `/ingatkan 30m ...`.
- Tersinkron di semua perangkat yang masuk dengan token yang sama.

## 1. Mulai

1. Buat token GitHub dengan scope **gist**: https://github.com/settings/tokens/new?scopes=gist&description=Kabar
2. Buka aplikasi, tempel token → Kabar membuat gist rahasia sebagai kotak pesan.
3. Di HP: pasang ke layar utama, buka **Setelan → Aktifkan notifikasi**. (iPhone: iOS 16.4+ dan harus dari ikon layar utama.)

## 2. Kirim pesan

Pengirim membutuhkan dua nilai rahasia:

| Nama | Isi |
|---|---|
| `KABAR_TOKEN` | token GitHub scope gist (sama dengan langkah 1) |
| `KABAR_VAPID` | kunci privat notifikasi milik pemilik aplikasi ini (tanpa ini pesan tetap masuk, tapi tanpa push) |
| `KABAR_KUNCI` | kata sandi enkripsi — hanya bila enkripsi diaktifkan |

**Terminal / Python** (`pip install requests pywebpush cryptography`):

```bash
python kabar.py "Backup selesai" "1,2 GB dalam 3 menit" --saluran Server
python kabar.py "Disk penuh!" "sisa 2%" -s Server --prioritas tinggi --url https://contoh.com
echo "log panjang..." | python kabar.py "Laporan harian" - -s Laporan
```

```python
import kabar
kabar.kirim("Harga emas", "Naik **2%** hari ini", saluran="Investasi")
kabar.kirim_banyak([{"judul": "A", "isi": "..."}, {"judul": "B", "isi": "..."}], saluran="Radar Saham")
```

**GitHub Actions** (repo mana pun):

```yaml
- uses: GabFx09/kabar@main
  with:
    saluran: Deploy
    judul: Situs berhasil diperbarui
    isi: Commit ${{ github.sha }}
    token: ${{ secrets.KABAR_TOKEN }}
    vapid: ${{ secrets.KABAR_VAPID }}
```

**HTTP / curl dari mana saja** (Shortcuts iPhone, IFTTT, server tanpa Python) — butuh token *fine-grained*
khusus repo ini dengan izin **Contents: Read and write**, plus secret `KABAR_TOKEN` & `KABAR_VAPID` di repo ini:

```bash
curl -X POST -H "Authorization: Bearer TOKEN_FINE_GRAINED" \
  https://api.github.com/repos/GabFx09/kabar/dispatches \
  -d '{"event_type":"kirim","client_payload":{"judul":"Halo","isi":"Tes dari curl","saluran":"Umum"}}'
```

**Manual dari GitHub:** tab Actions → *Kirim pesan manual* → Run workflow, atau
`gh workflow run kirim.yml -R GabFx09/kabar -f judul="Halo" -f isi="Tes"` (repo ini butuh secret `KABAR_TOKEN` & `KABAR_VAPID`).

Format isi: `**tebal**`, `_miring_`, `` `kode` ``, tautan otomatis, baris baru. Untuk HTML sederhana: `kabar.kirim(..., html="<b>..</b>")` atau `--html`.

### Tombol aksi & jawaban

```python
m = kabar.kirim("Deploy ke produksi?", "versi 2.4.1", saluran="Deploy", tombol=["Lanjut", "Batal"])
if kabar.tunggu_jawaban(m["id"], batas_detik=900) == "Lanjut":
    deploy()
```

```bash
python kabar.py "Matikan server?" "" -s Server --tombol "Ya,Tidak" --tunggu 600   # exit 0 bila dijawab
```

### Gambar

```python
kabar.kirim("Grafik harian", "p95 turun 18%", saluran="Laporan", gambar="grafik.png")   # atau URL https
```

### Pengingat terjadwal

Ketik di chat mana pun: `/ingatkan 07:30 minum obat`, `/ingatkan besok 08:00 ...`, `/ingatkan lusa 10:00 ...`,
`/ingatkan 25/12 09:00 ...`, `/ingatkan 30m ...` / `2 jam`, `/ingatkan setiap hari 06:00 ...`,
`/ingatkan setiap senin 09:00 ...`. Lihat `/pengingat`, batalkan `/batal 2`. Pengingat dikirim oleh workflow
*Pengingat terjadwal* di repo ini (tiap ±10 menit) — perlu secret `KABAR_TOKEN` & `KABAR_VAPID` di repo ini.

### Enkripsi

Aktifkan di **Setelan → Enkripsi end-to-end**. Semua pengirim harus diberi secret/variabel `KABAR_KUNCI` berisi kata
sandi yang sama; tanpa itu pengiriman gagal (agar tidak ada pesan tak terenkripsi yang tersimpan diam-diam).
Nama saluran, waktu, dan prioritas tetap terlihat (dibutuhkan untuk menyusun chat & notifikasi). Isi notifikasi push
dienkripsi oleh protokol Web Push sendiri. Pengingat terenkripsi dikirim tanpa server perlu tahu kata sandi.

## Notifikasi saat aplikasi ditutup

- Notifikasi dikirim lewat Web Push, jadi tetap muncul walau Kabar tidak dibuka (asal sudah **Aktifkan notifikasi** sekali di perangkat itu).
- **Perbaikan otomatis:** bila layanan push menolak perangkat (HTTP 404/410), perangkat ditandai dulu — tidak langsung dihapus —
  dan aplikasi / service worker meminta langganan baru sendiri. Perangkat baru dilepas setelah ditolak berulang kali selama >24 jam.
- **Cadangan latar belakang:** pada Chrome/Edge untuk Kabar yang dipasang di layar utama, service worker mengecek pesan baru
  secara berkala (Periodic Background Sync) dan menampilkan notifikasi untuk pesan yang belum diberitahukan.
- Log pengirim kini mencetak `kabar: notifikasi push → X/Y perangkat`, penolakan per perangkat, dan peringatan bila `KABAR_VAPID`
  tidak cocok dengan kunci publik aplikasi.

## Kunci notifikasi (VAPID)

Kunci publik tertanam di `docs/app.js` (`VAPID_PUBLIC`). Kunci privat **tidak** ada di repo; simpan sebagai secret
`KABAR_VAPID` di setiap tempat pengirim. Bila memakai kunci baru, ganti `VAPID_PUBLIC` lalu aktifkan ulang notifikasi
di setiap perangkat.

## Privasi

Token hanya disimpan di perangkat Anda dan hanya bisa mengakses gist. Gist "rahasia" tidak terdaftar publik,
tetapi siapa pun yang tahu alamatnya bisa membacanya — jangan kirim kata sandi atau data sangat sensitif lewat Kabar.

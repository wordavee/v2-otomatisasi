CAPTION STUDIO — VIDEO TIPE 1 & TIPE 3

Isi aplikasi:
- Tipe 3: video 4:5, ukuran tetap 2160 × 2700 px.
- Tipe 1: video 1:1, ukuran tetap 2160 × 2160 px.
- Musik bawaan: musik yang disertakan dalam paket ini, durasi sekitar 19,93 detik.
- Opsi memilih musik lain dari perangkat.
- Durasi setiap video otomatis mengikuti seluruh durasi musik.
- Satu quotes menghasilkan satu video. Banyak quotes akan dikemas menjadi ZIP.

Cara memakai:
1. Buka index.html atau langsung tipe3.html / tipe1.html.
2. Masukkan quotes manual atau unggah Excel/CSV.
3. Gunakan musik bawaan atau pilih musik lain.
4. Dengarkan preview musik bila perlu.
5. Klik "Generate video".

Catatan:
- Hasil ekspor SELALU .mp4. WebM tidak lagi digunakan sebagai hasil akhir.
- Codec target: H.264/AVC untuk video dan AAC untuk audio.
- Di Chrome/Edge aplikasi memakai encoder MP4 bawaan bila tersedia.
- Jika lingkungan seperti GPT Work tidak menyediakan encoder MP4 bawaan, aplikasi otomatis memakai FFmpeg WebAssembly sebagai fallback dan hasil tetap .mp4.
- Pada pemakaian fallback pertama kali, komponen encoder FFmpeg (~32 MB) diunduh dari CDN. Quotes, gambar, dan musik tetap diproses di browser dan tidak diunggah ke server aplikasi.
- Setelah memperbarui website lama, lakukan reload agar service worker versi baru aktif.

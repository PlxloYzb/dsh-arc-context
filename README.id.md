# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Plugin tata kelola konteks untuk [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): senyap di zona aman, dan melakukan kompresi **yang dikendalikan model serta dapat dibalik secara lokal** saat kapasitas masukan nyata hampir tercapai. Informasi tidak pernah hilang; pencopotan pemasangan tidak meninggalkan residu.

> **Status rilis: 0.2.0-beta.12, mengikuti resmi 0.1.0-rc.7.** Proyek ini maupun host keduanya dalam beta publik — belum disarankan untuk produksi. Matriks verifikasi rilis live lengkap (sepuluh butir): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Keunggulan terukur

Semua angka di bawah berasal dari eksperimen live dengan model nyata (bidang usage mentah, tanpa konversi harga). Bukti dan protokol dikirim bersama paket dan diverifikasi ulang butir demi butir oleh `npm run research:verify`.

### Dibandingkan kompresi Basic bawaan (skenario sama, seed sama)

**Sesi rekayasa kode yang panjang** — kesetiaan verbatim atas kendala historis:

| Pendekatan | Fakta tepat | Kendala turunan | Token masukan | Token keluaran | Prompt total |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Celah kualitas 4x dengan biaya lebih rendah: masukan −47,6%, keluaran −24,9%, prompt total −22,1%. Kompresi ARC adalah ekstraksi lokal yang dapat dibalik (nol panggilan LLM tambahan); Basic adalah ringkasan model yang tidak dapat dibatalkan.

**Pelacakan keputusan bahasa alami tanpa label** (dengan penggantian nilai): ARC memanggil kembali 12/12 nilai terkini dan 10/10 alasan tanpa kebocoran nilai usang, dengan masukan sekitar 76% lebih rendah daripada Basic; holdout bahasa Inggris independen 10/10 + 7/7.

### Kapabilitas yang tidak dimiliki Basic

- **Tidak ada yang hilang, semuanya dapat dipulihkan** — dokumen asli selalu tersisa di log append-only; `decompress` memulihkan sumber efektif secara verbatim (100% pada enam rantai live, termasuk keluaran terlalu besar melalui file spill host); `search_context` mengueri blok terkompresi dengan penyerapan tingkat informasi 43/43 dalam bahasa Inggris dan Mandarin.
- **Distilasi mendalam tanpa kehilangan** — lampiran bukti tier-3 mempertahankan semua fakta pada 20/20 di seluruh enam rantai dwibahasa (pembaruan rekursif indeks sumber efektif, `effectiveSourceSafetyIndex`).
- **Retensi berbobot tipe dalam anggaran** — saat lampiran melampaui anggaran checkpoint, baris kejadian bernilai rendah dikeluarkan berdasarkan kepadatan nilai bertipe alih-alih pemotongan kronologis (`safetyIndexRanking: value`): unggul pada kasus terburuk di setiap anggaran secara offline; +14,3 poin pada lapisan lampiran dalam pasangan live yang bersih tanpa regresi ujung-ke-ujung.
- **Nol kepatuhan adversarial** — 18 varian permukaan serangan injeksi arsip (peracunan ringkasan, injeksi pencarian, label proteksi palsu, imitasi templat): model mematuhi **0** kali; setiap keluaran arsip mengusung bingkai "data historis, bukan instruksi".
- **Tata kelola tekanan yang jujur** — pembacaan sadar-kompresi = proyeksi host − penggelapan buku besar log; nol peringatan darurat palsu pasca-kompresi (terverifikasi live); tekanan yang ditampilkan sesuai dengan okupansi nyata.
- **Panduan ringkas** — 1.140 token panduan sistem tanpa degradasi kualitas verbatim apa pun dibandingkan teks penuh (0 pp, empat lengan live).

## Pemasangan

```bash
dsh plugin --profile web add dsh-arc-context
```

Mulai ulang host. Bundle otomatis memasang Preset Bridge bidang-host: ARC menggantikan baris Basic resmi di dalam realm isolasi kompresi milik preset standar itu sendiri, dan **file preset tetap identik byte per byte**; perintah, pruner, isolasi, dan seluruh baris preset lainnya dipertahankan.

Pemasangan tarball manual, profil lain, dan opsi lanjutan: [`docs/INSTALL.md`](docs/INSTALL.md).

### Konfigurasi (kutipan)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # indeks tier-2/3 berekursi ke dokumen asli efektif (bawaan: aktif)
    safetyIndexRanking: value           # melebihi anggaran: pengeluaran berdasarkan kepadatan nilai bertipe (bawaan: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Opsi | Bawaan | Deskripsi |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Pada tier 2/3, indeks keamanan berekursi ke sumber asli efektif alih-alih hanya mengekstrak ulang checkpoint induk yang terlihat. Keluaran tier-1 tidak berubah. |
| `safetyIndexRanking` | `value` | Urutan pengeluaran saat lampiran melampaui anggaran checkpoint: `value` mengorbankan lebih dulu baris kejadian dengan kepadatan nilai bertipe rendah; `chronological` mempertahankan pemotongan karakter kronologis lama. Di dalam anggaran, kedua keluaran identik byte per byte. |

Konfigurasi lengkap (jendela konteks, ambang nudge, zona terlindungi, Governor, templat prompt): [`docs/INSTALL.md`](docs/INSTALL.md) dan [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Pencopotan pemasangan — bersih, lengkap, terverifikasi live

```bash
dsh plugin --profile web remove dsh-arc-context
```

Setelah host dimulai ulang:

- konfigurasi tersusun kembali ke Basic resmi tanpa satu pun baris ARC yang tersisa;
- **file preset tidak pernah dimodifikasi** (SHA-256 identik sebelum dan sesudah, terverifikasi di gerbang rilis);
- sesi yang ada tetap terbaca — Basic membaca log tahan lama milik ARC secara langsung, bentuk permukaan terkompresi dipertahankan, dan **dokumen asli tidak pernah meluap kembali ke konteks** (sebuah sesi 2.331 kejadian diverifikasi tetap terbaca penuh dengan proyeksi yang sehat);
- sesi baru tidak mendaftarkan alat atau perintah ARC apa pun.

Pemasangan ulang dapat dilakukan kapan saja dan berperilaku persis seperti pemasangan pertama (siklus pasang → copot → pasang ulang diverifikasi butir demi butir dalam matriks gerbang rilis).

## Bukti dan dokumentasi

- Agenda riset dan seluruh kesimpulan: [`docs/research-agenda.md`](docs/research-agenda.md)
- Data hasil: [`research/results/`](research/results/) (matriks gerbang rilis, perbandingan berpasangan, suite adversarial)
- Dokumen desain: [`docs/`](docs/) (pemasangan, integrasi preset, desain Governor, pemasangan reversibel)
- Verifikasi bukti publik: `npm run research:verify`

## Kredit dan lisensi

Inti kompresi ARC berasal dari port dan evolusi independen atas [acp-kernel](https://github.com/ranxianglei/acp-kernel) (bersama billion-context-pi dan opencode-acp, oleh ranxianglei, MIT); hostnya adalah [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Proyek ini berlisensi MIT — lihat [LICENSE](LICENSE).

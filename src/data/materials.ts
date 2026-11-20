import type { PaiElement } from '../types.ts';

export const CORE_PAI_ELEMENTS: PaiElement[] = [
  {
    id: 'quran_hadis',
    name: "Al-Qur'an dan Hadis",
    shortName: "Al-Qur'an Hadis",
    color: '#10b981',
    accentHex: 0x10b981,
    materialTitle: "Materi 1: Q.S. Al-'Asr dan Hukum Bacaan Mim Sukun",
    subtitle: 'Menghargai waktu, merangkai huruf hijaiyah, dan tajwid Mim Sukun (مْ)',
    sections: [
      {
        heading: "1. Informasi Umum & Menyambung Huruf Hijaiyah Q.S. Al-'Asr",
        paragraphs: [
          "Q.S. Al-'Asr adalah surah ke-103 dalam Al-Qur'an yang terdiri dari 3 ayat. Surah ini tergolong surah Makkiyah (diturunkan di Kota Makkah sebelum hijrah) dan namanya diambil dari kata pertama pada ayat pertama yang berarti 'Demi Masa' atau 'Waktu'.",
          "Teks Q.S. Al-'Asr: (1) وَالْعَصْرِ  (2) إِنَّ الْإِنْسَانَ لَفِي خُسْرٍ  (3) إِلَّا الَّذِينَ آمَنُوا وَعَمِلُوا الصَّالِحَاتِ وَتَوَاصَوْا بِالْحَقِّ وَتَوَاصَوْا بِالصَّبْرِ.",
        ],
        bullets: [
          "Kaidah Merangkai Huruf Hijaiyah: Huruf hijaiyah berubah bentuk di awal, tengah, dan akhir kata. Namun terdapat 6 huruf yang TIDAK bisa disambung dengan huruf sesudahnya: ا (Alif), د (Dal), ذ (Dzal), ر (Ra), ز (Zai), و (Wau).",
          "Contoh penguraian وَالْعَصْرِ (Wal-'asr): و - ا - ل - ع - ص - ر (6 huruf; wau & alif berdiri sendiri, sedangkan lam, 'ain, shad, dan ra bersambung).",
          "Contoh penguraian الْإِنْسَانَ (Al-insāna): ا - ل - إ - ن - س - ا - ن (7 huruf).",
          "Contoh penguraian الصَّالِحَاتِ (Ash-shālihāti): ا - ل - ص - ا - ل - ح - ا - ت (8 huruf).",
        ],
      },
      {
        heading: '2. Hukum Bacaan Mim Sukun (مْ)',
        paragraphs: [
          'Apabila huruf Mim Sukun (مْ) bertemu dengan salah satu huruf hijaiyah selain alif, hukum bacaannya terbagi menjadi tiga:',
        ],
        table: {
          headers: ['Hukum Bacaan', 'Huruf Pertemuan', 'Cara Membaca', 'Contoh Surah Pendek'],
          rows: [
            [
              'Ikhfa Syafawi',
              'ب (Ba)',
              'Dibaca samar-samar di bibir dan didengungkan selama 2 harakat.',
              'تَرْمِيْهِمْ بِحِجَارَةٍ (Q.S. Al-Fil: 4)',
            ],
            [
              'Idgham Mimi (Mutamatsilain)',
              'م (Mim)',
              'Dimasukkan/melebur ke huruf mim kedua disertai dengung 2 harakat.',
              'الَّذِيْ أَطْعَمَهُمْ مِنْ جُوْعٍ (Q.S. Quraisy: 4)',
            ],
            [
              'Izhar Syafawi',
              'Semua huruf hijaiyah selain م dan ب',
              'Dibaca jelas di bibir tanpa dengung.',
              'أَلَمْ تَرَ كَيْفَ (Q.S. Al-Fil: 1)',
            ],
          ],
        },
      },
      {
        heading: "3. Refleksi Pesan Pokok Q.S. Al-'Asr",
        paragraphs: [
          'Allah Swt. bersumpah demi waktu bahwa semua manusia berada dalam kerugian, kecuali mereka yang memiliki 4 sifat utama:',
        ],
        bullets: [
          'Beriman kepada Allah Swt. dengan sepenuh hati.',
          'Beramal saleh: melakukan perbuatan baik yang bermanfaat (rajin belajar, membantu orang tua, menjaga kebersihan).',
          'Saling menasihati dalam kebenaran (tawashau bil-haq) dengan cara yang santun.',
          'Saling menasihati dalam kesabaran (tawashau bish-shabr) saat menghadapi ujian atau kesulitan.',
        ],
        callout:
          'Hikmah Waktu: Waktu yang berlalu tidak pernah kembali. Gunakan setiap menit untuk iman, ilmu, dan amal kebaikan!',
      },
    ],
  },
  {
    id: 'akidah',
    name: 'Akidah',
    shortName: 'Akidah',
    color: '#3b82f6',
    accentHex: 0x3b82f6,
    materialTitle: 'Materi 2: Mengenal Allah Melalui Asmaul Husna',
    subtitle: 'Al-Halim, Asy-Syakur, Al-Hakim, dan Al-Wadud serta Muhasabah Diri',
    sections: [
      {
        heading: '1. Makna dan Contoh Perilaku Asmaul Husna',
        paragraphs: [
          'Asmaul Husna berjumlah 99 nama indah dan agung milik Allah Swt. Empat di antaranya sangat dekat dengan akhlak pelajar muslim sehari-hari:',
        ],
        table: {
          headers: ['Asmaul Husna', 'Arti', 'Makna Singkat', 'Contoh Perilaku Terpuji'],
          rows: [
            [
              'Al-Halim (الْحَلِيمُ)',
              'Maha Penyantun',
              'Allah tidak tergesa-gesa menghukum hamba-Nya yang bersalah, melainkan memberi waktu untuk bertobat.',
              'Tidak mudah marah saat teman berbuat salah, berbicara lembut, dan mudah memaafkan.',
            ],
            [
              'Asy-Syakur (الشَّكُورُ)',
              'Maha Mensyukuri / Pembalas Budi',
              'Allah membalas setiap amal kebaikan hamba-Nya dengan pahala berlipat ganda.',
              'Mengucap Alhamdulillah, berterima kasih kepada orang tua & guru, serta menjaga fasilitas sekolah.',
            ],
            [
              'Al-Hakim (الْحَكِيمُ)',
              'Maha Bijaksana',
              'Setiap ketetapan, aturan, dan ciptaan Allah memiliki tujuan dan hikmah yang tepat.',
              'Adil membagi tugas piket, berpikir matang sebelum bertindak, dan patuh aturan.',
            ],
            [
              'Al-Wadud (الْوَدُودُ)',
              'Maha Pengasih / Pencinta',
              'Allah mencintai hamba-Nya yang berbuat baik dengan kasih sayang yang tulus tanpa pamrih.',
              'Menyayangi adik, menghormati guru & orang tua, serta menjenguk teman yang sakit.',
            ],
          ],
        },
      },
      {
        heading: '2. Praktik Nyata & Evaluasi Diri (Muhasabah)',
        bullets: [
          'Praktik Nyata: Membiasakan mengucap Alhamdulillah saat mendapat nikmat (meneladani Asy-Syakur) dan menahan emosi ketika diganggu teman (meneladani Al-Halim).',
          'Langkah Evaluasi Sikap: Sebelum tidur, tanyakan pada diri sendiri: "Apakah hari ini saya sudah menyakiti hati teman? Sudahkah saya bersyukur atas makanan hari ini?"',
          'Jika masih ada kekhilafan, segera beristighfar dan bertekad memperbaikinya esok hari.',
        ],
        callout:
          'Muhasabah Harian: Meneladani Asmaul Husna membuat hati tenang, ramah pada sesama, dan bijaksana dalam setiap keputusan.',
      },
    ],
  },
  {
    id: 'akhlak',
    name: 'Akhlak',
    shortName: 'Akhlak',
    color: '#ec4899',
    accentHex: 0xec4899,
    materialTitle: 'Materi 3: Akhlak kepada Allah Swt. (Berdoa dan Bertawakal)',
    subtitle: 'Memadukan ikhtiar maksimal, adab berdoa, dan tawakal yang benar',
    sections: [
      {
        heading: '1. Pengertian Berdoa dan Bertawakal',
        bullets: [
          'Berdoa adalah memohon pertolongan, perlindungan, serta kebaikan hanya kepada Allah Swt. dengan penuh kerendahan hati. Rasulullah saw. bersabda bahwa doa adalah inti (otak) dari ibadah.',
          'Bertawakal adalah berserah diri sepenuhnya kepada Allah Swt. atas hasil dari suatu urusan, SETELAH melakukan usaha (ikhtiar) dan berdoa secara maksimal.',
          'Ikhtiar adalah usaha sungguh-sungguh yang dilakukan manusia sebelum bertawakal.',
        ],
      },
      {
        heading: '2. Adab Berdoa yang Benar & Cara Bertawakal',
        bullets: [
          'Dalam keadaan suci (berwudu) dan menghadap kiblat jika memungkinkan.',
          'Mengangkat kedua tangan, lalu mengawali doa dengan memuji Allah (Alhamdulillah) dan membaca salawat kepada Nabi Muhammad saw.',
          'Menyampaikan permohonan dengan suara lembut (tidak berteriak), penuh keyakinan, dan tidak tergesa-gesa.',
          'Menutup doa dengan salawat dan bacaan Alhamdulillahi rabbil ‘alamin.',
          'Waktu mustajab berdoa: saat sujud dalam salat, antara azan dan ikamah, serta saat turun hujan.',
          'Contoh Tawakal Pelajar: Belajar tekun di rumah (ikhtiar), berdoa sebelum ujian (doa), lalu menyerahkan nilai terbaik kepada Allah tanpa menyontek (tawakal).',
        ],
      },
      {
        heading: '3. Refleksi Keputusan Sikap (Tawakal vs Pasrah)',
        paragraphs: [
          'Tawakal bukanlah pasrah tanpa usaha! Jika seseorang ingin nilai bagus tetapi hanya berdoa tanpa belajar, itu bukan tawakal melainkan malas. Sebaliknya, berusaha keras tanpa berdoa adalah kesombongan (takabur).',
          'Hadis Teladan: "Ikatlah untamu, baru kemudian bertawakallah!" Artinya, iman tidak boleh meniadakan akal sehat dan tindakan pencegahan.',
        ],
        callout:
          'Rumus Sukses Muslim: Ikhtiar Maksimal + Doa Khusyuk + Tawakal Lapang Hati = Jiwa Tangguh & Optimis!',
      },
    ],
  },
  {
    id: 'fiqih',
    name: 'Fiqih',
    shortName: 'Fiqih',
    color: '#f59e0b',
    accentHex: 0xf59e0b,
    materialTitle: 'Materi 4: Ketentuan Puasa Wajib dan Puasa Sunnah',
    subtitle: 'Pengertian Shaum, syarat, rukun, sunnah, pembatal, dan hikmah puasa',
    sections: [
      {
        heading: '1. Pengertian & Kategori Puasa',
        paragraphs: [
          'Puasa (Shaum) secara bahasa berarti menahan diri. Secara istilah, puasa adalah menahan diri dari makan, minum, serta segala hal yang membatalkan puasa mulai terbit fajar (Subuh) hingga terbenam matahari (Magrib) disertai niat.',
        ],
        table: {
          headers: ['Kategori', 'Jenis Puasa', 'Keterangan Singkat'],
          rows: [
            ['Puasa Wajib', 'Puasa Ramadan', 'Sebulan penuh di bulan Ramadan bagi yang memenuhi syarat.'],
            ['Puasa Wajib', 'Puasa Qadha', 'Mengganti utang puasa Ramadan karena sakit atau musafir.'],
            ['Puasa Wajib', 'Puasa Nazar', 'Wajib dilaksanakan karena pernah berjanji kepada Allah.'],
            ['Puasa Wajib', 'Puasa Kafarat', 'Puasa sebagai denda akibat pelanggaran tertentu dalam syariat.'],
            ['Puasa Sunnah', 'Senin & Kamis', 'Dilaksanakan rutin setiap hari Senin dan Kamis.'],
            ['Puasa Sunnah', 'Puasa Syawal', '6 hari di bulan Syawal setelah Idulfitri (pahala seperti setahun).'],
            ['Puasa Sunnah', 'Puasa Arafah & Asyura', '9 Zulhijah (bagi non-haji) & 10 Muharam.'],
            ['Puasa Sunnah', 'Ayyamul Bidh', 'Tanggal 13, 14, dan 15 setiap bulan Hijriah.'],
          ],
        },
      },
      {
        heading: '2. Syarat, Rukun, Pembatal & Hari Haram Berpuasa',
        bullets: [
          'Syarat Wajib: Islam, baligh (dewasa), berakal sehat, dan mampu (kuat) berpuasa.',
          'Syarat Sah: Islam, mumayyiz (dapat membedakan baik & buruk), suci dari haid/nifas, dan pada waktu yang diperbolehkan.',
          'Rukun Puasa: (1) Niat di malam hari sebelum fajar (untuk puasa sunnah boleh pagi sebelum Zuhur asal belum makan/minum), (2) Menahan diri dari pembatal sejak Subuh hingga Magrib.',
          'Hal yang Membatalkan: Makan/minum sengaja, muntah sengaja, hilang akal/pingsan/gila, murtad, haid/nifas. (Makan/minum karena lupa TIDAK membatalkan).',
          'Hari Diharamkan Puasa: Hari Raya Idulfitri (1 Syawal), Iduladha (10 Zulhijah), dan Hari Tasyrik (11, 12, 13 Zulhijah).',
        ],
      },
      {
        heading: '3. Evaluasi Diri & Hikmah Puasa',
        paragraphs: [
          'Tujuan puasa adalah La‘allakum tattaqūn (agar kalian bertakwa). Puasa sejati menjaga lisan dari berkata kasar/bohong, menjaga mata, dan menumbuhkan empati kepada fakir miskin.',
        ],
        callout:
          'Ingat: Menahan lapar tanpa menjaga lisan tetap sah secara fiqih, tetapi menghilangkan pahala puasa!',
      },
    ],
  },
  {
    id: 'spi',
    name: 'Sejarah Peradaban Islam',
    shortName: 'SPI (Madinah)',
    color: '#8b5cf6',
    accentHex: 0x8b5cf6,
    materialTitle: 'Materi 5: Kepemimpinan Nabi Muhammad saw. di Madinah',
    subtitle: 'Strategi membangun peradaban damai, Piagam Madinah, dan teladan pemimpin',
    sections: [
      {
        heading: '1. Empat Strategi Utama Membangun Masyarakat Madinah',
        paragraphs: [
          'Sebelum hijrah, Kota Madinah bernama Yatsrib. Nabi Muhammad saw. mengubahnya menjadi Madinah Al-Munawwarah (Kota yang Bercahaya) dan membangun fondasi peradaban melalui 4 langkah besar:',
        ],
        bullets: [
          'Membangun Masjid (Masjid Quba sebagai masjid pertama, lalu Masjid Nabawi): Tidak hanya tempat salat, tetapi pusat pendidikan, musyawarah pemerintahan, dan membantu fakir miskin (Ahlus Suffah).',
          'Mempersaudarakan Kaum Muhajirin (pendatang dari Makkah) dan Kaum Anshar (penduduk asli penolong di Madinah) atas dasar ukhuwah Islamiyah, sekaligus mendamaikan suku Aus dan Khazraj.',
          'Menyusun Piagam Madinah (Shahifah Madinah): Konstitusi tertulis pertama di dunia yang menjamin hak asasi, kebebasan beragama, dan kerja sama membela kota antara Muslim dan non-Muslim.',
          'Membangun Pasar Madinah yang jujur, adil, bebas penipuan timbangan, penimbunan, dan riba.',
        ],
      },
      {
        heading: '2. Meneladani Kepemimpinan Rasulullah saw.',
        bullets: [
          'Musyawarah: Mengambil keputusan kelas melalui diskusi yang adil.',
          'Toleransi: Menghormati teman berbeda suku, budaya, dan agama tanpa mencampuradukkan akidah (lakum dīnukum wa liya dīn).',
          'Amanah, Jujur, dan Sederhana: Rasulullah tinggal sederhana di rumah berdinding tanah liat dekat Masjid Nabawi dan selalu terbuka kepada rakyatnya.',
        ],
        callout:
          'Kunci Kemajuan Bangsa: Persatuan, musyawarah mufakat, penegakan hukum yang adil, dan kasih sayang antarsesama.',
      },
    ],
  },
];

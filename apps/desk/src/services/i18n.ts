import { useState, useEffect } from 'react';

export type Locale = 'en' | 'ckb';

export interface TranslationSchema {
  screens: {
    inbox: string;
    review: string;
    dna: string;
    library: string;
    settings: string;
    ops: string;
    eval: string;
  };
  screenSubtitles: {
    inbox: string;
    review: string;
    dna: string;
    library: string;
    settings: string;
    ops: string;
    eval: string;
  };
  sidebar: {
    brandSubtitle: string;
    coreHealthy: string;
    healthDetails: string;
  };
  header: {
    searchPlaceholder: string;
    newTask: string;
    offlineCache: string;
    liveStream: string;
    connecting: string;
  };
  modal: {
    title: string;
    subtitle: string;
    autosaved: string;
    taskTitleLabel: string;
    taskTitlePlaceholder: string;
    taskCopyEnLabel: string;
    taskCopyEnPlaceholder: string;
    taskCopyCkbLabel: string;
    taskCopyCkbPlaceholder: string;
    copyLockNotice: string;
    cancel: string;
    submit: string;
    submitting: string;
  };
  review: {
    originalRequest: string;
    lockedBrief: string;
    exactNotice: string;
    evidence: string;
    timeline: string;
    qualityEvidence: string;
    decisionGate: string;
    safeZones: string;
    bidiIsolates: string;
    fontFamily: string;
    fontWeight: string;
    accentColor: string;
    layers: string;
    semanticDiff: string;
    approvePublish: string;
    approving: string;
    repairTrigger: string;
  };
}

export const translations: Record<Locale, TranslationSchema> = {
  en: {
    screens: {
      inbox: 'Inbox & Production Board',
      review: 'Task Review & Approval',
      dna: 'Client DNA & Brand Governance',
      library: 'Creative Library & Retrieval Evidence',
      settings: 'Adapters & Model Registry',
      ops: 'Actionable Operations & Health',
      eval: 'Model Evaluations & Canary Tournaments',
    },
    screenSubtitles: {
      inbox: 'Central operator desk, live task intake and pipeline transitions',
      review: 'Interactive vector HyCanvas editor, proof evidence, and publishing gate',
      dna: 'Brand tokens, approved copy invariants, and versioned client rules',
      library: 'Verified vector assets, SHA-256 fingerprints, and retrieval embeddings',
      settings: 'Connected channel bridges, ComfyUI worker sandbox, and model cascade status',
      ops: 'Real-time SLO latencies, circuit breakers, and storage reconciliation audits',
      eval: 'Adversarial red-team safety benchmarks, copy-guard, and golden suites',
    },
    sidebar: {
      brandSubtitle: 'Private Creative OS',
      coreHealthy: 'Core healthy',
      healthDetails: 'Telegram active · Desk canonical · WAHA quarantined',
    },
    header: {
      searchPlaceholder: 'Search tasks, clients, copy, hashes…',
      newTask: '+ New task',
      offlineCache: 'Offline (PWA Cache)',
      liveStream: 'Live Stream',
      connecting: 'Connecting…',
    },
    modal: {
      title: 'Create Task in Hawa Desk',
      subtitle: 'Canonical office intake with client scope lock and exact copy preservation.',
      autosaved: '💾 Autosaved',
      taskTitleLabel: 'Task Title (English)',
      taskTitlePlaceholder: 'e.g. Summer VIP Campaign',
      taskCopyEnLabel: 'Primary Headline & Offer (English)',
      taskCopyEnPlaceholder: 'e.g. Summer Grand Opening: 25% OFF all cold drinks!',
      taskCopyCkbLabel: 'Secondary Headline & Offer (Kurdish Sorani - Optional)',
      taskCopyCkbPlaceholder: 'بۆ نموونە: داشکاندنی هاوینە لەسەدا بیست و پێنج بۆ هەموو خواردنەوە ساردەکان',
      copyLockNotice: 'Exact copy blocks will be locked and cannot be rewritten by creative models.',
      cancel: 'Cancel',
      submit: 'Submit to Ingress',
      submitting: 'Submitting & Routing…',
    },
    review: {
      originalRequest: 'Original request',
      lockedBrief: 'Locked brief',
      exactNotice: 'Exact copy · cannot be rewritten by creative model',
      evidence: 'Evidence',
      timeline: 'Durable timeline',
      qualityEvidence: 'Quality evidence',
      decisionGate: 'Decision Gate',
      safeZones: 'Safe Zones',
      bidiIsolates: 'Bidi Isolates',
      fontFamily: 'Typography',
      fontWeight: 'Weight',
      accentColor: 'Accent',
      layers: 'Layers',
      semanticDiff: 'Compare R2',
      approvePublish: 'Approve & Publish to Drive',
      approving: 'Publishing to Drive...',
      repairTrigger: 'Request Automated Repair',
    },
  },
  ckb: {
    screens: {
      inbox: 'سندووقی هاتوو و تابلۆی بەرهەمهێنان',
      review: 'پێداچوونەوە و پەسەندکردنی ئەرک',
      dna: 'ناسنامەی کڕیار و یاساکانی براند',
      library: 'کتێبخانەی داهێنەرانە و بەڵگەکان',
      settings: 'ڕێکخستنی مۆدێل و پەیوەندییەکان',
      ops: 'تەندروستی کردارەکی و چاودێری',
      eval: 'هەڵسەنگاندنی مۆدێلەکان و تاقیکردنەوەکان',
    },
    screenSubtitles: {
      inbox: 'سەکۆی ناوەندیی ئۆفیس و گۆڕانکارییەکانی بەرهەمهێنان',
      review: 'دەستکاریکەری ڤێکتۆری هایکەنس، بەڵگەکان و بڵاوکردنەوە',
      dna: 'یاساکانی براند، کۆپی پەسەندکراو و مێژووی کڕیار',
      library: 'ئاسێتە ڤێکتۆرییەکان، کۆدی ئاسایش و بەڵگەنامەکان',
      settings: 'پەیوەندییەکانی تێلێگرام، کرێکاری کۆمفی و مۆدێلەکان',
      ops: 'خێرایی کارکردن و هەماهەنگی کۆگاکانی درایڤ و شیتس',
      eval: 'تاقیکردنەوەی ئاسایش لە بەرامبەر هێرش و تێکدان',
    },
    sidebar: {
      brandSubtitle: 'سیستەمی کارگێڕی دیزاین',
      coreHealthy: 'ناوکی چالاک',
      healthDetails: 'تێلێگرام چالاکە · دێسک ناوەندییە · وەها لە کەرەنتیندایە',
    },
    header: {
      searchPlaceholder: 'گەڕان بۆ ئەرک، کڕیار، تێکست، یان کۆد…',
      newTask: '+ ئەرکی نوێ',
      offlineCache: 'ئۆفلاین (کاشکراو)',
      liveStream: 'پەخشی ڕاستەوخۆ',
      connecting: 'پەیوەستبوون…',
    },
    modal: {
      title: 'دروستکردنی ئەرک لە هاوا دێسک',
      subtitle: 'داخڵکردنی ناوەندیی ئۆفیس بە پاراستنی تەواوی تێکست و براند.',
      autosaved: '💾 پاشەکەوتکراوە',
      taskTitleLabel: 'ناونیشانی ئەرک (ئینگلیزی)',
      taskTitlePlaceholder: 'بۆ نموونە: Summer VIP Campaign',
      taskCopyEnLabel: 'تێکستی سەرەکی و ئۆفەر (ئینگلیزی)',
      taskCopyEnPlaceholder: 'e.g. Summer Grand Opening: 25% OFF all cold drinks!',
      taskCopyCkbLabel: 'تێکستی دووەمی ئۆفەر (کوردی سۆرانی - ئارەزوومەندانە)',
      taskCopyCkbPlaceholder: 'بۆ نموونە: داشکاندنی هاوینە لەسەدا بیست و پێنج بۆ هەموو خواردنەوە ساردەکان',
      copyLockNotice: 'تێکستی نووسراو قوفڵ دەکرێت و مۆدێلەکان دەستکاری ناکەن.',
      cancel: 'پاشگەزبوونەوە',
      submit: 'ناردن بۆ سیستەم',
      submitting: 'ناردن و پۆلێنکردن…',
    },
    review: {
      originalRequest: 'داواکاری سەرەتایی',
      lockedBrief: 'کورتەی قوفڵکراو',
      exactNotice: 'تێکستی تەواو · مۆدێلی ژیری دەستکرد بۆی نییە بیگۆڕێت',
      evidence: 'بەڵگەنامەکان',
      timeline: 'هێڵی کاتیی تۆمارکراو',
      qualityEvidence: 'بەڵگەی جۆری و کوالیتی',
      decisionGate: 'دەروازەی بڕیاردان',
      safeZones: 'سنووری پارێزراو',
      bidiIsolates: 'جیاکەرەوەی دەق',
      fontFamily: 'فۆنت',
      fontWeight: 'قەبارە',
      accentColor: 'ڕەنگ',
      layers: 'چینەکان',
      semanticDiff: 'بەراوردکردنی ڕەشنووس',
      approvePublish: 'پەسەندکردن و بڵاوکردنەوە بۆ درایڤ',
      approving: 'بڵاوکردنەوە لەسەر درایڤ…',
      repairTrigger: 'داواکردنی چاکسازی خودکار',
    },
  },
};

class I18nManager {
  private currentLocale: Locale = 'en';
  private listeners: Set<(locale: Locale) => void> = new Set();

  constructor() {
    if (typeof window !== 'undefined' && window.localStorage) {
      const saved = window.localStorage.getItem('hawa_desk_locale') as Locale | null;
      if (saved === 'en' || saved === 'ckb') {
        this.currentLocale = saved;
      }
    }
  }

  getLocale(): Locale {
    return this.currentLocale;
  }

  isRTL(): boolean {
    return this.currentLocale === 'ckb';
  }

  setLocale(locale: Locale): void {
    if (this.currentLocale === locale) return;
    this.currentLocale = locale;
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('hawa_desk_locale', locale);
      document.documentElement.lang = locale;
      document.documentElement.dir = locale === 'ckb' ? 'rtl' : 'ltr';
    }
    this.listeners.forEach((fn) => fn(locale));
  }

  toggleLocale(): Locale {
    const next = this.currentLocale === 'en' ? 'ckb' : 'en';
    this.setLocale(next);
    return next;
  }

  getTranslations(): TranslationSchema {
    return translations[this.currentLocale] || translations.en;
  }

  subscribe(listener: (locale: Locale) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const i18nManager = new I18nManager();

export function useI18n() {
  const [locale, setLocaleState] = useState<Locale>(i18nManager.getLocale());

  useEffect(() => {
    return i18nManager.subscribe(setLocaleState);
  }, []);

  const toggleLocale = () => {
    i18nManager.toggleLocale();
  };

  const setLocale = (l: Locale) => {
    i18nManager.setLocale(l);
  };

  return {
    locale,
    isRtl: locale === 'ckb',
    t: translations[locale] || translations.en,
    setLocale,
    toggleLocale,
  };
}

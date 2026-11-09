import { Injectable, Pipe, PipeTransform } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UiLanguage {
  current: 'zh-CN' | 'en' = localStorage.getItem('fynote-language') === 'en' ? 'en' : 'zh-CN';

  constructor() {
    document.documentElement.lang = this.current;
  }

  toggle() {
    this.set(this.current === 'en' ? 'zh-CN' : 'en');
  }

  set(language: 'zh-CN' | 'en') {
    if (this.current === language) return;
    this.current = language;
    document.documentElement.lang = language;
    localStorage.setItem('fynote-language', language);
    // The Chinese layer rewrites DOM text; reload so both states stay coherent.
    location.reload();
  }
}

@Pipe({ name: 'uiText', pure: false, standalone: false })
export class UiTextPipe implements PipeTransform {
  constructor(private language: UiLanguage) {}

  transform(english: string, chinese: string): string {
    return this.language.current === 'en' ? english : chinese;
  }
}

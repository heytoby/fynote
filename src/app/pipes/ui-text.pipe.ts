import { Injectable, Pipe, PipeTransform } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class UiLanguage {
  current: 'zh-CN' | 'en' = localStorage.getItem('fynote-language') === 'en' ? 'en' : 'zh-CN';

  constructor() {
    document.documentElement.lang = this.current;
  }

  toggle() {
    this.current = this.current === 'en' ? 'zh-CN' : 'en';
    document.documentElement.lang = this.current;
    localStorage.setItem('fynote-language', this.current);
  }
}

@Pipe({ name: 'uiText', pure: false, standalone: false })
export class UiTextPipe implements PipeTransform {
  constructor(private language: UiLanguage) {}

  transform(english: string, chinese: string): string {
    return this.language.current === 'en' ? english : chinese;
  }
}

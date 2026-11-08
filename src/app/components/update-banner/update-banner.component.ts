import { Component, Input, OnInit } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { AuthService } from 'src/app/services/auth.service';
import { ManagedHostingService } from 'src/app/services/managed-hosting.service';
import { environment } from 'src/environments/environment';

interface UpdateStatus {
  current: string;
  latest: string | null;
  releaseUrl: string | null;
  releaseNotes: string | null;
  publishedAt: string | null;
  isOutdated: boolean;
  desktop: boolean;
  canInstall: boolean;
  updateProgress?: { received: number; total: number } | null;
  suppressed: boolean;
  dismissedForever: boolean;
  dismissedUntil: string | null;
  checkedAt: string | null;
  checkError: string | null;
}

interface DesktopUpdateInfo {
  current: string;
  latest: string;
  isOutdated: boolean;
  canInstall: boolean;
  releaseUrl: string | null;
  notes: string | null;
}

type DesktopUpdateBridge = {
  check(): Promise<DesktopUpdateInfo>;
  install(): Promise<{ version: string }>;
};

function desktopUpdateBridge(): DesktopUpdateBridge | null {
  const api = (window as unknown as { fynote?: { update?: DesktopUpdateBridge } }).fynote;
  return api?.update ?? null;
}

@Component({
  selector: 'app-update-banner',
  templateUrl: './update-banner.component.html',
  styleUrls: ['./update-banner.component.scss'],
  standalone: false
})
export class UpdateBannerComponent implements OnInit {
  @Input() manual = false;
  status: UpdateStatus | null = null;
  showNotes = false;
  checking = false;
  installing = false;
  message = '';

  constructor(private http: HttpClient, public auth: AuthService, private managedHosting: ManagedHostingService) {}

  async ngOnInit() {
    // The desktop shell owns the update lifecycle itself: there is no server,
    // so ask the Electron bridge instead of the admin HTTP endpoint.
    if (desktopUpdateBridge()) { await this.refreshFromDesktop(); return; }
    if (!this.auth.isAdmin) return;
    // A managed-hosting provider owns the update lifecycle; nagging the
    // customer to update themselves would contradict that.
    const { managed } = await this.managedHosting.info();
    if (managed) return;
    await this.refresh();
  }

  private async refreshFromDesktop() {
    const bridge = desktopUpdateBridge();
    if (!bridge) return;
    try {
      const info = await bridge.check();
      this.status = {
        current: info.current, latest: info.latest, releaseUrl: info.releaseUrl, releaseNotes: info.notes,
        publishedAt: null, isOutdated: info.isOutdated, desktop: true, canInstall: info.canInstall,
        suppressed: false, dismissedForever: false, dismissedUntil: null,
        checkedAt: new Date().toISOString(), checkError: null
      };
    } catch {
      this.status = null;
    }
  }

  async refresh() {
    try {
      this.status = await firstValueFrom(
        this.http.get<UpdateStatus>(`${environment.apiUrl}/admin/update-status`, { headers: this.auth.authHeaders() })
      );
    } catch {
      this.status = null;
    }
  }

  async checkForUpdates() {
    if (this.checking || this.installing) return;
    this.checking = true;
    this.message = '';
    const bridge = desktopUpdateBridge();
    if (bridge) {
      try {
        await this.refreshFromDesktop();
        if (!this.status) this.message = '检查更新失败，请稍后重试。';
        else if (!this.status.isOutdated) this.message = '当前已是最新版本。';
        else this.message = `发现新版本 ${this.status.latest}。`;
      } finally {
        this.checking = false;
      }
      return;
    }
    try {
      this.status = await firstValueFrom(
        this.http.get<UpdateStatus>(`${environment.apiUrl}/admin/update-status`, {
          headers: this.auth.authHeaders(),
          params: { check: '1' }
        })
      );
      if (this.status.checkError) this.message = '暂时无法连接 GitHub，请稍后重试。';
      else if (!this.status.latest) this.message = 'GitHub 上暂无正式版本。';
      else if (!this.status.isOutdated) this.message = '当前已是最新版本。';
      else this.message = `发现新版本 ${this.status.latest}。`;
    } catch {
      this.status = null;
      this.message = '检查更新失败，请稍后重试。';
    } finally {
      this.checking = false;
    }
  }

  async installUpdate() {
    if (this.installing || this.checking || !this.status?.canInstall || !this.status.latest) return;
    const bridge = desktopUpdateBridge();
    if (bridge) {
      this.installing = true;
      this.message = '正在下载并校验更新包…';
      try {
        const result = await bridge.install();
        this.message = `正在安装 ${result.version} 并重启 Fynote。`;
      } catch (error) {
        this.message = error instanceof Error ? error.message : '更新安装失败，请稍后重试。';
        this.installing = false;
      }
      return;
    }
    this.installing = true;
    this.message = '正在连接 GitHub 下载更新包。';
    const progress = setInterval(async () => {
      try {
        const update = await firstValueFrom(this.http.get<UpdateStatus>(
          `${environment.apiUrl}/admin/update-status`,
          { headers: this.auth.authHeaders() }
        ).pipe(timeout(2500)));
        const download = update.updateProgress;
        if (this.installing && download?.total) {
          const percent = Math.min(100, Math.floor(download.received / download.total * 100));
          this.message = percent === 100 ? '下载完成，正在校验更新包。' : `正在下载更新包 ${percent}%`;
        }
      } catch { /* Keep the last progress while a status request is unavailable. */ }
    }, 3000);
    try {
      const result = await firstValueFrom(
        this.http.post<{ version: string }>(`${environment.apiUrl}/admin/update-status/install`,
          { version: this.status.latest }, { headers: this.auth.authHeaders() }).pipe(timeout(16 * 60_000))
      );
      clearInterval(progress);
      this.message = '正在安装并重启 Fynote。';
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 750));
        try {
          const response = await fetch(`${environment.apiUrl}/health`, {
            cache: 'no-store', signal: AbortSignal.timeout(2500)
          });
          if (response.ok && response.headers.get('X-Fynote-Desktop-Version') === result.version) {
            window.location.reload();
            return;
          }
        } catch {
          // The local server is briefly offline during the restart.
        }
      }
      this.message = '重启后暂未检测到新版。请重新打开 Fynote，再检查当前版本。';
    } catch (error) {
      const detail = (error as { error?: { error?: string } }).error?.error;
      this.message = detail || (error instanceof Error && error.name === 'TimeoutError'
        ? '下载等待超时，请检查网络后重试。' : '更新安装失败，请稍后重试。');
    } finally {
      clearInterval(progress);
      this.installing = false;
    }
  }

  get visible(): boolean {
    return !this.manual && !!this.status?.isOutdated && !this.status.suppressed;
  }

  toggleNotes(event: Event) {
    event.preventDefault();
    this.showNotes = !this.showNotes;
  }

  async dismiss(forever: boolean) {
    if (!this.status?.latest) return;
    try {
      await firstValueFrom(
        this.http.post(
          `${environment.apiUrl}/admin/update-status/dismiss`,
          { version: this.status.latest, forever },
          { headers: this.auth.authHeaders() }
        )
      );
      await this.refresh();
      this.showNotes = false;
    } catch {
      // best effort; banner stays
    }
  }
}

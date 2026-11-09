import {
  Component,
  Input as NgInput,
  ElementRef,
  EventEmitter,
  Input,
  OnDestroy,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
  ViewChild,
  AfterViewInit
} from '@angular/core'
import { CommonModule } from '@angular/common'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language'
import MarkdownIt from 'markdown-it'

type Mode = 'edit' | 'split' | 'preview'

@Component({
  selector: 'app-markdown-editor',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="md-shell">
      <div class="md-toolbar">
        <div class="md-actions">
          <button type="button" title="标题" (click)="wrap('## ', '')">H</button>
          <button type="button" title="加粗" (click)="wrap('**', '**')"><b>B</b></button>
          <button type="button" title="斜体" (click)="wrap('*', '*')"><i>I</i></button>
          <button type="button" title="删除线" (click)="wrap('~~', '~~')"><s>S</s></button>
          <button type="button" title="行内代码" (click)="wrap('\`', '\`')">&lt;/&gt;</button>
          <button type="button" title="引用" (click)="prefix('&gt; ')">❝</button>
          <button type="button" title="无序列表" (click)="prefix('- ')">•</button>
          <button type="button" title="有序列表" (click)="prefix('1. ')">1.</button>
          <button type="button" title="任务列表" (click)="prefix('- [ ] ')">☑</button>
          <button type="button" title="链接" (click)="wrap('[', '](https://)')">🔗</button>
          <button type="button" title="代码块" (click)="codeBlock()">&#123; &#125;</button>
          <button type="button" title="分割线" (click)="insert('\n---\n')">—</button>
        </div>
        <div class="md-modes">
          <button type="button" [class.active]="mode === 'edit'" (click)="setMode('edit')">编辑</button>
          <button type="button" [class.active]="mode === 'split'" (click)="setMode('split')">分栏</button>
          <button type="button" [class.active]="mode === 'preview'" (click)="setMode('preview')">预览</button>
        </div>
      </div>
      <div class="md-body" [class.split]="mode === 'split'" [class.preview-only]="mode === 'preview'">
        <div class="md-editor" #host [hidden]="mode === 'preview'"></div>
        <div class="md-preview markdown-preview" [hidden]="mode === 'edit'" [innerHTML]="rendered"></div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; flex: 1 1 auto; height: 100%; min-height: 0; }
    .md-shell { display: flex; flex: 1 1 auto; flex-direction: column; height: 100%; min-height: 0; width: 100%; overflow: hidden; }
    .md-toolbar {
      align-items: center;
      border-bottom: 1px solid #ececec;
      display: flex;
      flex: 0 0 auto;
      gap: 12px;
      justify-content: space-between;
      padding: 6px 10px;
    }
    .md-actions { display: flex; flex-wrap: wrap; gap: 2px; }
    .md-actions button, .md-modes button {
      background: transparent;
      border: 0;
      border-radius: 4px;
      color: #3c4043;
      cursor: pointer;
      font-size: 13px;
      min-width: 30px;
      padding: 4px 6px;
    }
    .md-actions button:hover, .md-modes button:hover { background: #f1f3f4; }
    .md-modes { display: flex; gap: 2px; }
    .md-modes button.active { background: #e8f0fe; color: #1a73e8; }
    .md-body { display: grid; flex: 1 1 auto; grid-template-columns: 1fr; min-height: 0; min-width: 0; overflow: hidden; }
    .md-body.split { grid-template-columns: 1fr 1fr; }
    .md-body > * { box-sizing: border-box; min-height: 0; min-width: 0; overflow: hidden; }
    .md-editor { display: flex; height: 100%; min-height: 0; min-width: 0; overflow: hidden; }
    .md-editor .cm-editor { flex: 1 1 auto; font-size: 15px; height: 100%; min-width: 0; }
    .md-editor .cm-scroller { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; line-height: 1.65; }
    .md-body.split .md-editor, .md-body.split .md-preview { flex: 1 1 0; min-width: 0; }
    .md-body.split .md-editor { border-right: 1px solid #ececec; }
    .md-preview {
      min-width: 0;
      font-family: "Source Han Sans SC", "Microsoft YaHei", sans-serif;
      font-size: 15px;
      line-height: 1.75;
      min-height: 0;
      overflow-y: auto;
      padding: 20px 28px;
      width: 100%;
    }
    .md-preview :is(h1, h2, h3) { margin: 0.8em 0 0.4em; }
    .md-preview pre { background: #f6f8fa; border-radius: 6px; overflow-x: auto; padding: 12px; }
    .md-preview code { background: #f1f3f4; border-radius: 3px; padding: 1px 4px; }
    .md-preview pre code { background: transparent; padding: 0; }
    .md-preview blockquote { border-left: 3px solid #dadce0; color: #5f6368; margin: 0.6em 0; padding-left: 12px; }
    .md-preview table { border-collapse: collapse; }
    .md-preview td, .md-preview th { border: 1px solid #dadce0; padding: 4px 8px; }
  `]
})
export class MarkdownEditorComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  @Input() value = ''
  @Output() valueChange = new EventEmitter<string>()

  @ViewChild('host', { static: false }) host?: ElementRef<HTMLElement>

  mode: Mode = 'edit'
  rendered = ''

  private view?: EditorView
  private md = new MarkdownIt({ html: false, linkify: true, breaks: true })

  ngOnInit() {
    this.rendered = this.md.render(this.value || '')
  }

  ngOnChanges(changes: SimpleChanges) {
    if (!changes['value']) return
    this.rendered = this.md.render(this.value || '')
    const view = this.view
    if (!view) return
    const next = this.value || ''
    if (next !== view.state.doc.toString()) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
    }
  }

  ngAfterViewInit() {
    if (!this.host) return
    const view = new EditorView({
      parent: this.host.nativeElement,
      state: EditorState.create({
        doc: this.value || '',
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          EditorView.lineWrapping,
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            const text = update.state.doc.toString()
            this.value = text
            this.valueChange.emit(text)
            this.rendered = this.md.render(text)
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: '#fff', color: '#202124' },
            '.cm-content': { padding: '16px 20px' },
            '.cm-gutters': { backgroundColor: '#fff', border: 'none', color: '#bdc1c6' },
            '.cm-activeLine': { backgroundColor: '#f8f9fa' },
            '&.cm-focused': { outline: 'none' }
          })
        ]
      })
    })
    this.view = view
    // CodeMirror measures on mount; the panel is laid out a frame later.
    requestAnimationFrame(() => this.view?.requestMeasure())
    window.addEventListener('resize', this.onResize)
  }

  private onResize = () => this.view?.requestMeasure()

  setMode(mode: Mode) {
    this.mode = mode
    if (mode !== 'preview') setTimeout(() => this.view?.requestMeasure(), 0)
  }

  ngOnDestroy() {
    window.removeEventListener('resize', this.onResize)
    this.view?.destroy()
  }

  private replaceSelection(text: string) {
    const view = this.view
    if (!view) return
    view.dispatch(view.state.replaceSelection(text))
    view.focus()
  }

  private selectionText() {
    const view = this.view
    if (!view) return ''
    const { from, to } = view.state.selection.main
    return view.state.sliceDoc(from, to)
  }

  wrap(prefix: string, suffix = prefix) {
    this.replaceSelection(prefix + this.selectionText() + suffix)
  }

  insert(text: string) {
    this.replaceSelection(text)
  }

  codeBlock() {
    const selected = this.selectionText() || 'code'
    this.replaceSelection('```\n' + selected + '\n```')
  }

  prefix(marker: string) {
    const view = this.view
    if (!view) return
    const { from, to } = view.state.selection.main
    const startLine = view.state.doc.lineAt(from).number
    const endLine = view.state.doc.lineAt(to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = view.state.doc.line(n)
      view.dispatch({ changes: { from: line.from, insert: marker } })
    }
    view.focus()
  }
}

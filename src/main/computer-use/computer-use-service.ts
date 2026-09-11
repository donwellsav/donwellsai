import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../shared/logger'

export interface ComputerUseConfig {
  /** Browser-use Python package path. */
  pythonPath?: string
  /** Browser-use module entry point. */
  browserUseModule?: string
  /** Whether to run in headless mode. */
  headless?: boolean
  /** Display resolution. */
  displaySize?: { width: number; height: number }
  /** Action timeout in ms. */
  actionTimeoutMs?: number
}

export interface BrowserAction {
  type: 'click' | 'type' | 'scroll' | 'navigate' | 'screenshot' | 'read' | 'wait' | 'select'
  selector?: string
  text?: string
  url?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  timeout?: number
}

export interface ActionResult {
  success: boolean
  screenshot?: string
  pageContent?: string
  error?: string
}

/**
 * Computer-use integration service.
 *
 * Provides browser automation and desktop interaction capabilities.
 * Uses Python's browser-use package under the hood.
 *
 * This is the foundation for agents that can interact with
 * web applications, fill forms, take screenshots, and more.
 */
export class ComputerUseService {
  private config: Required<ComputerUseConfig>

  constructor(config: ComputerUseConfig = {}) {
    this.config = {
      pythonPath: 'python3',
      browserUseModule: 'browser_use',
      headless: false,
      displaySize: { width: 1280, height: 720 },
      actionTimeoutMs: 30000,
      ...config,
    }
  }

  /**
   * Executes a browser action via browser-use.
   */
  async executeAction(action: BrowserAction): Promise<ActionResult> {
    const scriptPath = await this.generateActionScript(action)
    try {
      return await this.runBrowserUseScript(scriptPath)
    } finally {
      await rm(scriptPath, { force: true })
    }
  }

  /**
   * Takes a screenshot of the current browser state.
   */
  async takeScreenshot(url?: string): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'screenshot',
      url,
      timeout: this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Reads the text content of a web page.
   */
  async readPage(url: string): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'read',
      url,
      timeout: this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Navigates to a URL.
   */
  async navigate(url: string): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'navigate',
      url,
      timeout: this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Clicks an element by selector.
   */
  async click(selector: string, timeout?: number): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'click',
      selector,
      timeout: timeout ?? this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Types text into an element.
   */
  async type(selector: string, text: string): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'type',
      selector,
      text,
      timeout: this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Scrolls the page.
   */
  async scroll(direction: 'up' | 'down' | 'left' | 'right' = 'down', amount = 300): Promise<ActionResult> {
    const action: BrowserAction = {
      type: 'scroll',
      direction,
      amount,
      timeout: this.config.actionTimeoutMs,
    }
    return this.executeAction(action)
  }

  /**
   * Checks if browser-use is available.
   */
  async checkAvailability(): Promise<{ browserUse: boolean; python: boolean }> {
    const python = await this.checkPython()
    const browserUse = python ? await this.checkBrowserUseModule() : false
    return { browserUse, python }
  }

  /**
   * Runs a Python script that uses browser-use.
   */
  private async runBrowserUseScript(scriptPath: string): Promise<ActionResult> {
    return new Promise<ActionResult>((resolve) => {
      const startTime = Date.now()
      const proc = spawn(this.config.pythonPath, [scriptPath], {
        env: {
          ...process.env,
          BROWSER_USE_HEADED: this.config.headless ? '0' : '1',
          BROWSER_USE_DISPLAY_WIDTH: String(this.config.displaySize.width),
          BROWSER_USE_DISPLAY_HEIGHT: String(this.config.displaySize.height),
        },
        timeout: this.config.actionTimeoutMs,
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      proc.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      proc.on('close', (code) => {
        const duration = Date.now() - startTime
        logger.info({ code, duration }, 'computer-use: action completed')

        if (code !== 0) {
          resolve({ success: false, error: stderr || `Process exited with code ${code}` })
          return
        }

        try {
          const result = JSON.parse(stdout) as ActionResult
          resolve(result)
        } catch {
          resolve({ success: true, pageContent: stdout })
        }
      })

      proc.on('error', (err: Error) => {
        logger.error({ err }, 'computer-use: action failed')
        resolve({ success: false, error: err.message })
      })
    })
  }

  /**
   * Generates a temporary Python script for browser-use.
   */
  private async generateActionScript(action: BrowserAction): Promise<string> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'donwells-cu-'))
    const scriptPath = join(tmpDir, 'action.py')

    const script = this.buildPythonScript(action)
    await writeFile(scriptPath, script, 'utf-8')
    return scriptPath
  }

  private buildPythonScript(action: BrowserAction): string {
    const lines: string[] = [
      'import json',
      'import sys',
      'from browser_use import Agent',
      'from browser_use.browser import BrowserSession, BrowserProfile',
      '',
      'profile = BrowserProfile(',
      '    headless=' + String(this.config.headless) + ',',
      '    window_size="' + this.config.displaySize.width + 'x' + this.config.displaySize.height + '"',
      ')',
      'session = BrowserProfile(profile)',
      'agent = Agent(session=session)',
      '',
    ]

    switch (action.type) {
      case 'navigate':
        lines.push(`agent.navigate("${action.url}")`)
        lines.push(`result = {"success": True, "pageContent": agent.get_page_text()}`)
        break
      case 'click':
        lines.push(`agent.click("${action.selector}")`)
        lines.push(`result = {"success": True}`)
        break
      case 'type':
        lines.push(`agent.type("${action.selector}", "${action.text}")`)
        lines.push(`result = {"success": True}`)
        break
      case 'scroll':
        lines.push(`agent.scroll("${action.direction}", ${action.amount})`)
        lines.push(`result = {"success": True}`)
        break
      case 'screenshot':
        lines.push(`screenshot = agent.take_screenshot()`)
        lines.push(`result = {"success": True, "screenshot": screenshot}`)
        break
      case 'read':
        lines.push(`agent.navigate("${action.url}")`)
        lines.push(`result = {"success": True, "pageContent": agent.get_page_text()}`)
        break
      case 'select':
        lines.push(`agent.select("${action.selector}", "${action.text}")`)
        lines.push(`result = {"success": True}`)
        break
      case 'wait':
        lines.push(`agent.wait(${action.timeout ?? 5000})`)
        lines.push(`result = {"success": True}`)
        break
    }

    lines.push('')
    lines.push('print(json.dumps(result))')

    return lines.join('\n')
  }

  private async checkPython(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(this.config.pythonPath, ['--version'])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  private async checkBrowserUseModule(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn(this.config.pythonPath, ['-c', 'import browser_use'])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

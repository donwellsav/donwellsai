import { spawn } from 'node:child_process'
import { readFile as fsReadFile } from 'node:fs/promises'
import { writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../../shared/logger'

export interface VoiceConfig {
  /** OpenAI Whisper API key. Falls back to env OPENAI_API_KEY. */
  whisperApiKey?: string
  /** Whisper API base URL. */
  whisperBaseUrl?: string
  /** Path to Piper TTS binary. */
  piperBin?: string
  /** Piper voice model directory. */
  piperModelDir?: string
  /** Input device index for recording. */
  inputDevice?: number
  /** Sample rate for audio recording. */
  sampleRate?: number
}

export interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
  confidence?: number
}

export interface SpeechResult {
  audioPath: string
  durationMs: number
}

/**
 * Voice input/output service.
 *
 * - Speech-to-text: OpenAI Whisper API (or compatible)
 * - Text-to-speech: Piper TTS (local, offline)
 *
 * The service is designed to work with a push-to-talk UI pattern.
 * Audio is recorded to a temp file, then transcribed.
 */
export class VoiceService {
  private config: VoiceConfig
  private recordingProcess: ReturnType<typeof spawn> | null = null

  constructor(config: VoiceConfig = {}) {
    this.config = {
      sampleRate: 16000,
      ...config,
    }
  }

  /**
   * Checks if the voice dependencies are available.
   */
  async checkAvailability(): Promise<{
    whisper: boolean
    piper: boolean
    microphone: boolean
  }> {
    const whisper = await this.checkWhisper()
    const piper = await this.checkPiper()
    const microphone = await this.checkMicrophone()

    return { whisper, piper, microphone }
  }

  /**
   * Transcribes an audio file using Whisper.
   */
  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    const apiKey = this.config.whisperApiKey || process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('Whisper API key not configured')
    }

    const baseUrl = this.config.whisperBaseUrl || 'https://api.openai.com/v1'

    const formData = new FormData()
    const fileBuffer = await streamToBuffer(audioPath)
    formData.append('file', new Blob([fileBuffer]), 'audio.wav')
    formData.append('model', 'whisper-1')

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(`Whisper API error: ${response.status} ${error}`)
    }

    const result = (await response.json()) as { text: string; language?: string; duration?: number }
    logger.info({ language: result.language, duration: result.duration }, 'voice: transcribed')

    return {
      text: result.text,
      language: result.language,
      duration: result.duration,
    }
  }

  /**
   * Starts recording audio from the microphone.
   *
   * Uses `sox` or `rec` command to record audio to a temp file.
   * Returns a handle to stop recording.
   */
  async startRecording(): Promise<{ stop: () => Promise<string> }> {
    const tmpDir = await mkdtemp(join(tmpdir(), 'donwells-voice-'))
    const outputPath = join(tmpDir, 'recording.wav')

    // Try sox first, fall back to rec
    const recorder = spawn('sox', [
      '-d', // default device
      '-r', String(this.config.sampleRate),
      '-c', '1', // mono
      '-b', '16', // 16-bit
      outputPath,
    ])

    this.recordingProcess = recorder

    return {
      stop: () => {
        return new Promise<string>((resolve, reject) => {
          if (!this.recordingProcess) {
            reject(new Error('Not recording'))
            return
          }

          recorder.kill('SIGINT')
          recorder.on('close', () => {
            this.recordingProcess = null
            resolve(outputPath)
          })
          recorder.on('error', reject)
        })
      },
    }
  }

  /**
   * Converts text to speech using Piper TTS.
   */
  async speak(text: string): Promise<SpeechResult> {
    const piperBin = this.config.piperBin || 'piper'
    const modelDir = this.config.piperModelDir

    if (!modelDir) {
      throw new Error('Piper model directory not configured')
    }

    const tmpDir = await mkdtemp(join(tmpdir(), 'donwells-tts-'))
    const outputPath = join(tmpDir, 'speech.wav')

    return new Promise<SpeechResult>((resolve, reject) => {
      const startTime = Date.now()
      const piper = spawn(piperBin, [
        '--model', join(modelDir, 'en_US-medium.onnx'),
        '--output_file', outputPath,
      ])

      piper.stdin.write(text)
      piper.stdin.end()

      piper.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Piper exited with code ${code}`))
          return
        }

        resolve({
          audioPath: outputPath,
          durationMs: Date.now() - startTime,
        })
      })

      piper.on('error', reject)
    })
  }

  private async checkWhisper(): Promise<boolean> {
    const apiKey = this.config.whisperApiKey || process.env.OPENAI_API_KEY
    return !!apiKey
  }

  private async checkPiper(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn('piper', ['--version'])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }

  private async checkMicrophone(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const proc = spawn('sox', ['-d', '-r', '16000', '-c', '1', '-b', '16', '/dev/null', 'trim', '0', '0.1'])
      proc.on('close', (code) => resolve(code === 0))
      proc.on('error', () => resolve(false))
    })
  }
}

async function streamToBuffer(filePath: string): Promise<ArrayBuffer> {
  const data = await fsReadFile(filePath)
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
}

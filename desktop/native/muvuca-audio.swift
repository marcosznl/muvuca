// muvuca-audio: captura o som de UM app (o dono da janela que está sendo transmitida) ou do computador
// inteiro menos o Muvuca, usando o ScreenCaptureKit (macOS 13+) — o mesmo recurso do sistema que o Discord usa.
//
// Uso:  muvuca-audio --window <CGWindowID>
//       muvuca-audio --display <CGDirectDisplayID> [--exclude-pid <pid>]… [--exclude-bundle <prefixo>]
// Saída (stdout): áudio PCM float32 intercalado, 48 kHz, 2 canais, sem cabeçalho.
// Mensagens (stderr): uma linha por evento, começando com "ok", "erro:" ou "info:".
// Encerra sozinho quando o app fecha a entrada (stdin) — nunca fica rodando órfão.

import AVFoundation
import CoreMedia
import Foundation
import ScreenCaptureKit

let SAMPLE_RATE = 48_000
let CHANNELS = 2

func say(_ line: String) {
  FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String) -> Never {
  say("erro: \(message)")
  exit(1)
}

// ---------- Argumentos ----------

var windowID: UInt32?
var displayID: UInt32?
var excludePIDs: [pid_t] = []
var excludeBundles: [String] = []
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
  switch a {
  case "--window": windowID = args.next().flatMap { UInt32($0) }
  case "--display": displayID = args.next().flatMap { UInt32($0) }
  case "--exclude-pid": if let p = args.next().flatMap({ pid_t($0) }) { excludePIDs.append(p) }
  case "--exclude-bundle": if let b = args.next() { excludeBundles.append(b) }
  default: fail("argumento desconhecido \(a)")
  }
}
if windowID == nil && displayID == nil { fail("use --window <id> ou --display <id>") }

// ---------- Saída do áudio ----------

final class Output: NSObject, SCStreamOutput, SCStreamDelegate {
  private let out = FileHandle.standardOutput
  private var scratch = [Float]()

  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .audio, buffer.isValid, let format = CMSampleBufferGetFormatDescription(buffer),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { return }
    let frames = CMSampleBufferGetNumSamples(buffer)
    if frames == 0 { return }

    // O ScreenCaptureKit entrega float32 com os canais separados; juntamos intercalando (L R L R…)
    var blockBuffer: CMBlockBuffer?
    var sizeNeeded = 0
    CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: &sizeNeeded, bufferListOut: nil, bufferListSize: 0,
      blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: nil)
    let listPtr = UnsafeMutableRawPointer.allocate(byteCount: sizeNeeded, alignment: MemoryLayout<AudioBufferList>.alignment)
    defer { listPtr.deallocate() }
    let list = listPtr.bindMemory(to: AudioBufferList.self, capacity: 1)
    let status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(buffer, bufferListSizeNeededOut: nil, bufferListOut: list,
      bufferListSize: sizeNeeded, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
      flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, blockBufferOut: &blockBuffer)
    guard status == noErr else { return }
    let buffers = UnsafeMutableAudioBufferListPointer(list)
    let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
    let nonInterleaved = asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved != 0
    guard isFloat, asbd.mBitsPerChannel == 32 else { return }

    scratch.removeAll(keepingCapacity: true)
    scratch.reserveCapacity(frames * CHANNELS)
    if nonInterleaved {
      let left = buffers[0].mData!.assumingMemoryBound(to: Float.self)
      let right = (buffers.count > 1 ? buffers[1].mData! : buffers[0].mData!).assumingMemoryBound(to: Float.self)
      for i in 0..<frames { scratch.append(left[i]); scratch.append(right[i]) }
    } else {
      let chans = Int(asbd.mChannelsPerFrame)
      let data = buffers[0].mData!.assumingMemoryBound(to: Float.self)
      for i in 0..<frames {
        let l = data[i * chans]
        scratch.append(l)
        scratch.append(chans > 1 ? data[i * chans + 1] : l)
      }
    }
    scratch.withUnsafeBufferPointer { p in
      out.write(Data(buffer: p))
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("a captura parou: \(error.localizedDescription)")
  }
}

// ---------- Começo ----------

let output = Output()
var stream: SCStream?

Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    let filter: SCContentFilter
    if let wid = windowID {
      guard let window = content.windows.first(where: { $0.windowID == wid }) else { fail("janela não encontrada") }
      guard let app = window.owningApplication else { fail("não achei o app dessa janela") }
      // O som é separado por app (é assim no macOS): vai o som do app dono da janela
      let display = content.displays.first(where: { $0.frame.intersects(window.frame) }) ?? content.displays.first
      guard let display else { fail("nenhuma tela encontrada") }
      filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
      say("info: som do \(app.applicationName)")
    } else {
      guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else { fail("tela não encontrada") }
      // Tela inteira: todo o som do computador, menos o Muvuca (senão a galera ouviria a própria call)
      let excluded = content.applications.filter { app in
        excludePIDs.contains(app.processID) || excludeBundles.contains { app.bundleIdentifier.hasPrefix($0) }
      }
      filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
      say("info: som do computador")
      FileHandle.standardError.write("debug: sem \(excluded.map(\.bundleIdentifier).joined(separator: ", "))\n".data(using: .utf8)!)
    }

    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.sampleRate = SAMPLE_RATE
    config.channelCount = CHANNELS
    config.excludesCurrentProcessAudio = true
    // A imagem vem pelo Electron; aqui só o som (o vídeo fica mínimo para não gastar nada)
    config.width = 2
    config.height = 2
    config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    config.queueDepth = 3

    let s = SCStream(filter: filter, configuration: config, delegate: output)
    let queue = DispatchQueue(label: "muvuca.audio")
    try s.addStreamOutput(output, type: .audio, sampleHandlerQueue: queue)
    try s.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "muvuca.video")) // ignorado
    try await s.startCapture()
    stream = s
    say("ok")
  } catch {
    fail(error.localizedDescription)
  }
}

// O app fechou a entrada (parou a live ou saiu): encerra
DispatchQueue.global().async {
  while FileHandle.standardInput.availableData.count > 0 {}
  exit(0)
}
signal(SIGPIPE, SIG_IGN) // quem lê saiu: o write falha e o laço acima encerra
dispatchMain()

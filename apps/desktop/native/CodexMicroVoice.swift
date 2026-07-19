import AVFoundation
import Foundation
import Speech

private final class VoiceCapture {
    private let audioEngine = AVAudioEngine()
    private let recognizer = SFSpeechRecognizer(locale: Locale.current)
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var transcript = ""
    private var stopping = false
    private var finished = false
    private var tapInstalled = false

    func run() {
        emit(state: "requesting-permission")
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.fail("Speech Recognition permission was denied.", code: "permission-denied")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard granted else {
                            self.fail("Microphone permission was denied.", code: "permission-denied")
                            return
                        }
                        self.startCapture()
                    }
                }
            }
        }
    }

    func stop() {
        guard !finished, !stopping else { return }
        stopping = true
        emit(state: "transcribing")
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            self?.finish()
        }
    }

    private func startCapture() {
        guard let recognizer, recognizer.isAvailable else {
            fail("Apple Speech Recognition is unavailable for the current language.", code: "unavailable")
            return
        }
        let speechRequest = SFSpeechAudioBufferRecognitionRequest()
        speechRequest.shouldReportPartialResults = true
        // Prefer Apple's fully local recognizer when this Mac and locale expose it.
        // Otherwise let the same system Speech framework use its normal macOS
        // recognition path instead of making the MIC key fail outright.
        speechRequest.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition
        request = speechRequest

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("The selected macOS input device has no usable audio format.", code: "capture-failed")
            return
        }
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            speechRequest.append(buffer)
        }
        tapInstalled = true

        task = recognizer.recognitionTask(with: speechRequest) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, !self.finished else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                    if result.isFinal && self.stopping { self.finish() }
                    return
                }
                if let error, !self.stopping {
                    self.fail("Transcription failed: \(error.localizedDescription)", code: "transcription-failed")
                }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            emit(state: "listening")
        } catch {
            fail("Microphone capture failed: \(error.localizedDescription)", code: "capture-failed")
        }
    }

    private func finish() {
        guard !finished else { return }
        finished = true
        task?.cancel()
        task = nil
        request = nil
        emit(state: "idle", transcript: transcript.trimmingCharacters(in: .whitespacesAndNewlines))
        exitSoon()
    }

    private func fail(_ message: String, code: String) {
        guard !finished else { return }
        finished = true
        if audioEngine.isRunning { audioEngine.stop() }
        if tapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            tapInstalled = false
        }
        task?.cancel()
        emit(state: "error", error: message, code: code)
        exitSoon()
    }

    private func emit(state: String, transcript: String? = nil, error: String? = nil, code: String? = nil) {
        var value: [String: Any] = ["state": state]
        if let transcript { value["transcript"] = transcript }
        if let error { value["error"] = error }
        if let code { value["code"] = code }
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let newline = "\n".data(using: .utf8) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(newline)
    }

    private func exitSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { Foundation.exit(EXIT_SUCCESS) }
    }
}

@main
private enum CodexMicroVoiceMain {
    static func main() {
        let capture = VoiceCapture()
        DispatchQueue.global(qos: .userInitiated).async {
            while let line = readLine() {
                if line.trimmingCharacters(in: .whitespacesAndNewlines) == "stop" {
                    DispatchQueue.main.async { capture.stop() }
                }
            }
            DispatchQueue.main.async { capture.stop() }
        }
        DispatchQueue.main.async { capture.run() }
        dispatchMain()
    }
}

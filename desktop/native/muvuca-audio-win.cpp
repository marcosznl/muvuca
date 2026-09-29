// muvuca-audio.exe (Windows): som da live só do programa da janela transmitida — igual ao muvuca-audio do Mac.
// Usa a captura por processo do Windows (Windows 10 2004 ou mais novo), a mesma que o Discord e o OBS usam.
//
//   muvuca-audio.exe --window <HWND>          só o som do programa dono da janela (e dos processos filhos dele)
//   muvuca-audio.exe --display <id> --exclude-pid <PID>   o som de tudo, menos o do Muvuca (a call não volta)
//   muvuca-audio.exe --probe                  só confere se este Windows tem o recurso (sai com 0 se tiver)
//
// Saída: áudio float32, 48 kHz, estéreo, intercalado, no stdout. Avisos no stderr: "ok", "info: ...", "erro: ...".
// Para quando o stdin fecha (o app do Muvuca fecha ao parar a live).
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <tlhelp32.h>
#include <io.h>
#include <fcntl.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

// ---- Da audioclientactivationparams.h (não vem no mingw) ----
typedef enum { AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1 } AUDIOCLIENT_ACTIVATION_TYPE;
typedef enum { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1 } PROCESS_LOOPBACK_MODE;
typedef struct { DWORD TargetProcessId; PROCESS_LOOPBACK_MODE ProcessLoopbackMode; } AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;
typedef struct { AUDIOCLIENT_ACTIVATION_TYPE ActivationType; AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams; } AUDIOCLIENT_ACTIVATION_PARAMS;
static const wchar_t *PROCESS_LOOPBACK_DEVICE = L"VAD\\Process_Loopback";

// GUIDs das interfaces (declarados aqui para não depender das bibliotecas do mingw)
static const GUID kIID_IUnknown = {0x00000000, 0x0000, 0x0000, {0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}};
static const GUID kIID_IAudioClient = {0x1CB9AD4C, 0xDBFA, 0x4C32, {0xB1, 0x78, 0xC2, 0xF5, 0x68, 0xA7, 0x03, 0xB2}};
static const GUID kIID_IAudioCaptureClient = {0xC8ADBD64, 0xE71E, 0x48A0, {0xA4, 0xDE, 0x18, 0x5C, 0x39, 0x5C, 0xD3, 0x17}};
static const GUID kIID_Handler = {0x41D949AB, 0x9862, 0x444A, {0x80, 0xF6, 0xC2, 0x61, 0x33, 0x4D, 0xA5, 0xEB}};
static const GUID kIID_IAgileObject = {0x94EA2B94, 0xE9CC, 0x49E0, {0xC0, 0xFF, 0xEE, 0x64, 0xCA, 0x8F, 0x5B, 0x90}};

typedef HRESULT(WINAPI *ActivateFn)(LPCWSTR, REFIID, PROPVARIANT *, IActivateAudioInterfaceCompletionHandler *, IActivateAudioInterfaceAsyncOperation **);

static void say(const char *fmt, const char *arg = "") {
  fprintf(stderr, fmt, arg);
  fputc('\n', stderr);
  fflush(stderr);
}

// Recebe o resultado da ativação (a API é assíncrona). Precisa ser "agile" (IAgileObject).
class Handler : public IActivateAudioInterfaceCompletionHandler {
  LONG ref = 1;
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  virtual ~Handler() { CloseHandle(done); }
  HRESULT result = E_FAIL;
  IAudioClient *client = nullptr;
  STDMETHODIMP QueryInterface(REFIID riid, void **out) override {
    if (IsEqualGUID(riid, kIID_IUnknown) || IsEqualGUID(riid, kIID_Handler) || IsEqualGUID(riid, kIID_IAgileObject)) {
      *out = static_cast<IActivateAudioInterfaceCompletionHandler *>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&ref); }
  STDMETHODIMP_(ULONG) Release() override {
    ULONG r = InterlockedDecrement(&ref);
    if (!r) delete this;
    return r;
  }
  STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation *op) override {
    HRESULT activated = E_FAIL;
    IUnknown *unk = nullptr;
    result = op->GetActivateResult(&activated, &unk);
    if (SUCCEEDED(result)) result = activated;
    if (SUCCEEDED(result) && unk) result = unk->QueryInterface(kIID_IAudioClient, reinterpret_cast<void **>(&client));
    if (unk) unk->Release();
    SetEvent(done);
    return S_OK;
  }
};

// Nome do executável de um processo (para o aviso "Transmitindo o som de ...")
static std::string processName(DWORD pid) {
  std::string name;
  HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap == INVALID_HANDLE_VALUE) return name;
  PROCESSENTRY32W e;
  e.dwSize = sizeof(e);
  for (BOOL ok = Process32FirstW(snap, &e); ok; ok = Process32NextW(snap, &e)) {
    if (e.th32ProcessID != pid) continue;
    char buf[MAX_PATH];
    WideCharToMultiByte(CP_UTF8, 0, e.szExeFile, -1, buf, sizeof(buf), nullptr, nullptr);
    name = buf;
    break;
  }
  CloseHandle(snap);
  return name;
}

// Apps da Microsoft Store: a janela de fora pertence ao ApplicationFrameHost; o som vem do app de dentro
struct ChildSearch { DWORD frame; DWORD found; };
static BOOL CALLBACK findInnerApp(HWND child, LPARAM lp) {
  auto *s = reinterpret_cast<ChildSearch *>(lp);
  DWORD pid = 0;
  GetWindowThreadProcessId(child, &pid);
  if (pid && pid != s->frame) { s->found = pid; return FALSE; }
  return TRUE;
}
static DWORD windowProcess(HWND hwnd) {
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid && _stricmp(processName(pid).c_str(), "ApplicationFrameHost.exe") == 0) {
    ChildSearch s{pid, 0};
    EnumChildWindows(hwnd, findInnerApp, reinterpret_cast<LPARAM>(&s));
    if (s.found) pid = s.found;
  }
  return pid;
}

static IAudioClient *activate(DWORD pid, PROCESS_LOOPBACK_MODE mode, const char **why) {
  HMODULE mmdev = LoadLibraryW(L"Mmdevapi.dll");
  auto fn = mmdev ? reinterpret_cast<ActivateFn>(GetProcAddress(mmdev, "ActivateAudioInterfaceAsync")) : nullptr;
  if (!fn) { *why = "este Windows nao tem captura de som por programa"; return nullptr; }
  AUDIOCLIENT_ACTIVATION_PARAMS params = {};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = mode;
  PROPVARIANT prop;
  PropVariantInit(&prop);
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof(params);
  prop.blob.pBlobData = reinterpret_cast<BYTE *>(&params);
  auto *handler = new Handler();
  IActivateAudioInterfaceAsyncOperation *op = nullptr;
  HRESULT hr = fn(PROCESS_LOOPBACK_DEVICE, kIID_IAudioClient, &prop, handler, &op);
  IAudioClient *client = nullptr;
  if (FAILED(hr)) *why = "o Windows recusou a captura (versao antiga?)";
  else if (WaitForSingleObject(handler->done, 5000) != WAIT_OBJECT_0) *why = "o Windows nao respondeu a tempo";
  else if (FAILED(handler->result) || !handler->client) *why = "o Windows nao liberou o som desse programa";
  else { client = handler->client; client->AddRef(); }
  if (handler->client) handler->client->Release();
  if (op) op->Release();
  handler->Release();
  return client;
}

static volatile LONG stopping = 0;
static DWORD WINAPI watchStdin(LPVOID) {
  char buf[64];
  while (fread(buf, 1, sizeof(buf), stdin) > 0) {}
  InterlockedExchange(&stopping, 1); // o app fechou o stdin: parar
  return 0;
}

int main(int argc, char **argv) {
  DWORD pid = 0;
  bool probe = false;
  bool window = false;
  PROCESS_LOOPBACK_MODE mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--probe")) probe = true;
    else if (!strcmp(argv[i], "--window") && i + 1 < argc) {
      window = true;
      HWND hwnd = reinterpret_cast<HWND>(static_cast<uintptr_t>(strtoull(argv[++i], nullptr, 10)));
      pid = windowProcess(hwnd);
      mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    } else if (!strcmp(argv[i], "--exclude-pid") && i + 1 < argc) {
      DWORD p = static_cast<DWORD>(strtoul(argv[++i], nullptr, 10));
      if (!window && !pid) { pid = p; mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE; }
    } else if (!strcmp(argv[i], "--display") && i + 1 < argc) {
      ++i; // a tela em si não importa para o som: é tudo menos o Muvuca (--exclude-pid)
    }
  }
  if (probe) { pid = GetCurrentProcessId(); mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE; }
  if (!pid) { say("erro: %s", window ? "nao achei o programa dessa janela" : "faltou dizer o que capturar"); return 2; }

  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  const char *why = "";
  IAudioClient *client = activate(pid, mode, &why);
  if (!client) { say("erro: %s", why); return 3; }
  if (probe) { client->Release(); return 0; }

  WAVEFORMATEX fmt = {};
  fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  fmt.nChannels = 2;
  fmt.nSamplesPerSec = 48000;
  fmt.wBitsPerSample = 32;
  fmt.nBlockAlign = 8;
  fmt.nAvgBytesPerSec = 48000 * 8;
  HANDLE ready = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                  200000 /* 20 ms */, 0, &fmt, nullptr);
  IAudioCaptureClient *capture = nullptr;
  if (SUCCEEDED(hr)) hr = client->SetEventHandle(ready);
  if (SUCCEEDED(hr)) hr = client->GetService(kIID_IAudioCaptureClient, reinterpret_cast<void **>(&capture));
  if (SUCCEEDED(hr)) hr = client->Start();
  if (FAILED(hr)) { say("erro: %s", "nao deu para comecar a captura do som"); return 4; }

  _setmode(_fileno(stdout), _O_BINARY);
  CreateThread(nullptr, 0, watchStdin, nullptr, 0, nullptr);
  say("ok");
  if (mode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE) {
    std::string name = processName(pid);
    if (!name.empty()) say("info: o som de %s", name.c_str());
  } else {
    say("info: %s", "o som do computador (sem a call)");
  }

  static float silence[48000 * 2];
  while (!stopping) {
    if (WaitForSingleObject(ready, 200) != WAIT_OBJECT_0) continue;
    UINT32 packet = 0;
    while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
      BYTE *data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) break;
      const void *src = (flags & AUDCLNT_BUFFERFLAGS_SILENT) || !data ? silence : static_cast<const void *>(data);
      if (frames <= 48000 && fwrite(src, 8, frames, stdout) != frames) InterlockedExchange(&stopping, 1); // o app foi embora
      capture->ReleaseBuffer(frames);
    }
    fflush(stdout);
  }
  client->Stop();
  capture->Release();
  client->Release();
  CoUninitialize();
  return 0;
}

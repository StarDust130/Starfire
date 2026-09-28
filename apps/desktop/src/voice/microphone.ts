export type MicrophoneDevice = {
  id: string;
  label: string;
};

function isProbablyRealMicrophone(device: MicrophoneDevice): boolean {
  const label = device.label.toLowerCase();

  const blockedWords = ["loopback", "monitor", "speaker", "output", "hdmi"];

  if (blockedWords.some((word) => label.includes(word))) {
    return false;
  }

  const microphoneWords = [
    "microphone",
    "microphone array",
    "mic",
    "analog",
    "digital",
    "input",
    "internal",
    "built-in",
  ];

  return microphoneWords.some((word) => label.includes(word));
}

export async function getMicrophones(): Promise<MicrophoneDevice[]> {
  const permissionStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });

  for (const track of permissionStream.getTracks()) {
    track.stop();
  }

  const devices = await navigator.mediaDevices.enumerateDevices();

  return devices
    .filter(
      (device) => device.kind === "audioinput" && device.deviceId.length > 0,
    )
    .map((device) => ({
      id: device.deviceId,
      label: device.label || "Unknown microphone",
    }));
}

export function chooseMicrophone(
  devices: MicrophoneDevice[],
): MicrophoneDevice | null {
  const preferred = devices.find((device) => isProbablyRealMicrophone(device));

  return preferred ?? devices[0] ?? null;
}

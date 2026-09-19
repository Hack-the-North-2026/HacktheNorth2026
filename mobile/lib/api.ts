import { Platform } from 'react-native';

// Standard default localhost URL for iOS Simulator, Android Emulator, and web/dev
const getBackendUrl = () => {
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:8000';
  }
  return 'http://localhost:8000';
};

export const API_BASE_URL = getBackendUrl();

export async function processTikTokUrl(url: string) {
  const response = await fetch(`${API_BASE_URL}/api/process-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.detail || `Server responded with status ${response.status}`);
  }

  return await response.json();
}

export async function checkBackendHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  return await response.json();
}

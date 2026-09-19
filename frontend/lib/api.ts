import { Platform } from 'react-native';
import { IdentifyResult } from './types';

// Frontend talks to the Node backend (port 4000), which proxies to the AI service.
const getBackendUrl = () => {
  if (Platform.OS === 'android') {
    return 'http://10.0.2.2:4000';
  }
  return 'http://localhost:4000';
};

export const API_BASE_URL = getBackendUrl();

function mockIdentifyResult(uri: string): IdentifyResult {
  return {
    job_id: `mock-${Date.now()}`,
    status: 'done',
    origin: 'app',
    thumbnail_url: uri,
    outfit_summary: 'Oversized black leather biker jacket over a white tee, with light-wash denim.',
    items: [
      {
        garment: {
          id: 'garment-1',
          category: 'jacket',
          description: 'Oversized black leather biker jacket',
          search_query: 'oversized black leather biker jacket',
          attributes: { color: 'black', material: 'leather', fit: 'oversized' },
          brand: null,
          brand_cues: [],
          confidence: 0.91,
          bbox: [120, 80, 420, 460],
          chip_key: 'chip-1',
          accessibility_line: 'A black leather biker jacket with silver zip details.',
        },
        matches: [
          {
            title: 'Oversized Leather Biker Jacket',
            url: 'https://www.shopify.com/example/biker-jacket',
            image_url: 'https://picsum.photos/seed/biker-jacket/400/500',
            price: '189.00',
            currency: 'CAD',
            store_name: 'Nova Studios',
            source: 'shopify',
            match_type: 'exact',
            confidence: 0.88,
            reason: 'Same silhouette, material, and zip placement as the reference photo.',
          },
          {
            title: 'Faux Leather Moto Jacket',
            url: 'https://www.shopify.com/example/moto-jacket',
            image_url: 'https://picsum.photos/seed/moto-jacket/400/500',
            price: '96.00',
            currency: 'CAD',
            store_name: 'Rareform',
            source: 'shopify',
            match_type: 'similar',
            confidence: 0.71,
            reason: 'Same color and silhouette, different collar shape.',
          },
        ],
      },
      {
        garment: {
          id: 'garment-2',
          category: 'pants',
          description: 'Light-wash straight-leg denim jeans',
          search_query: 'light wash straight leg denim jeans',
          attributes: { color: 'light blue', material: 'denim', fit: 'straight' },
          brand: null,
          brand_cues: [],
          confidence: 0.85,
          bbox: [140, 460, 380, 780],
          chip_key: 'chip-2',
          accessibility_line: 'Light-wash straight-leg denim jeans.',
        },
        matches: [
          {
            title: 'Straight Leg Jean — Light Wash',
            url: 'https://www.shopify.com/example/straight-jean',
            image_url: 'https://picsum.photos/seed/denim-jean/400/500',
            price: '78.00',
            currency: 'CAD',
            store_name: 'Field Denim Co.',
            source: 'shopify',
            match_type: 'similar',
            confidence: 0.74,
            reason: 'Same wash and leg shape; slightly higher rise.',
          },
        ],
      },
    ],
  };
}

export async function identifyImage(uri: string): Promise<IdentifyResult> {
  await new Promise((resolve) => setTimeout(resolve, 600));
  return mockIdentifyResult(uri);
}

export async function checkBackendHealth() {
  const response = await fetch(`${API_BASE_URL}/health`);
  return await response.json();
}

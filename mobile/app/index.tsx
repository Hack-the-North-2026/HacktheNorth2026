import React, { useState } from 'react';
import { StyleSheet, Text, View, TextInput, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { processTikTokUrl } from '../lib/api';

export default function HomeScreen() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const handleProcess = async () => {
    if (!url.trim()) {
      Alert.alert('Error', 'Please enter a valid TikTok URL');
      return;
    }

    setLoading(true);
    setResult(null);
    try {
      const data = await processTikTokUrl(url.trim());
      setResult(data);
    } catch (error: any) {
      Alert.alert('Processing Failed', error.message || 'Could not connect to backend server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Fit Stealer</Text>
      <Text style={styles.subtitle}>Steal outfit links directly from TikTok videos</Text>

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          placeholder="Paste TikTok URL here..."
          placeholderTextColor="#888"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.button} onPress={handleProcess} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Steal Fit</Text>
          )}
        </TouchableOpacity>
      </View>

      {result && (
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>Processing Result:</Text>
          <Text style={styles.resultText}>{JSON.stringify(result, null, 2)}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F0F12',
    padding: 24,
    justifyContent: 'center',
  },
  title: {
    fontSize: 36,
    fontWeight: '800',
    color: '#FFFFFF',
    textAlign: 'center',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#A0A0AB',
    textAlign: 'center',
    marginBottom: 32,
  },
  inputContainer: {
    gap: 12,
  },
  input: {
    backgroundColor: '#1C1C22',
    borderWidth: 1,
    borderColor: '#2E2E38',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#FFFFFF',
    fontSize: 16,
  },
  button: {
    backgroundColor: '#6366F1',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  resultCard: {
    marginTop: 24,
    backgroundColor: '#1C1C22',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2E2E38',
  },
  resultTitle: {
    color: '#6366F1',
    fontWeight: '700',
    marginBottom: 8,
  },
  resultText: {
    color: '#D1D5DB',
    fontFamily: 'monospace',
    fontSize: 12,
  },
});

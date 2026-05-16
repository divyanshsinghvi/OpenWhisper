/**
 * ModelRouter.ts
 *
 * Intelligent model routing system
 * Automatically selects the best available model based on requirements
 */

import { STTModel, ModelInfo, TranscriptionOptions, TranscriptionResult } from './ModelInterface';
import { MoonshineModel } from './MoonshineModel';

export interface RoutingPreferences {
  priority: 'speed' | 'accuracy' | 'balance';
  language?: string;
  maxMemory?: number; // in MB
  requireOffline?: boolean;
  platform?: 'desktop' | 'mobile' | 'server';
}

export class ModelRouter {
  private models: STTModel[] = [];
  private availableModels: Map<string, STTModel> = new Map();
  private initialized: boolean = false;

  constructor() {
    // Batch transcription path uses Moonshine only (the streaming engines —
    // Nemotron, Moonshine streaming — are wired separately in main.ts).
    this.models = [
      new MoonshineModel('base'),
      new MoonshineModel('tiny'),
    ];
  }

  /**
   * Initialize router by checking which models are available
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    console.log('Initializing ModelRouter...');

    // Check models in priority order and stop at first available
    for (const model of this.models) {
      const available = await model.isAvailable();
      if (available) {
        const info = model.getInfo();
        this.availableModels.set(info.name, model);
        console.log(`[OK] ${info.name} is available`);

        // Initialize the model (loads resources, starts servers, etc)
        await model.initialize();

        // Stop checking - use first available model
        break;
      }
    }

    if (this.availableModels.size === 0) {
      throw new Error('No STT models available. Please install at least one model.');
    }

    this.initialized = true;
    console.log(`ModelRouter initialized with ${this.availableModels.size} model(s)`);
  }

  /**
   * Select the best model based on preferences
   */
  selectModel(preferences?: RoutingPreferences): STTModel {
    if (!this.initialized) {
      throw new Error('ModelRouter not initialized. Call initialize() first.');
    }

    const prefs = preferences || { priority: 'balance' };

    // Filter models based on requirements
    let candidates = Array.from(this.availableModels.values());

    // Filter by language
    if (prefs.language && prefs.language !== 'en') {
      candidates = candidates.filter(model => {
        const info = model.getInfo();
        return info.languages.includes(prefs.language!) ||
               info.languages.includes('multilingual');
      });
    }

    // Filter by memory constraints
    if (prefs.maxMemory) {
      candidates = candidates.filter(model => {
        const info = model.getInfo();
        const memoryMB = this.parseMemory(info.estimatedMemory);
        return memoryMB <= prefs.maxMemory!;
      });
    }

    // Score and rank models based on priority
    const scoredModels = candidates.map(model => ({
      model,
      score: this.calculateScore(model, prefs)
    }));

    // Sort by score (descending)
    scoredModels.sort((a, b) => b.score - a.score);

    if (scoredModels.length === 0) {
      throw new Error('No models match the specified criteria');
    }

    const selected = scoredModels[0].model;
    console.log(`Selected model: ${selected.getInfo().name} (score: ${scoredModels[0].score})`);

    return selected;
  }

  /**
   * Calculate score for a model based on preferences
   */
  private calculateScore(model: STTModel, prefs: RoutingPreferences): number {
    const info = model.getInfo();
    let score = 0;

    // Speed scoring
    const speedScore = {
      'ultra-fast': 100,
      'fast': 70,
      'medium': 40,
      'slow': 10
    }[info.speed];

    // Accuracy scoring
    const accuracyScore = {
      'excellent': 100,
      'good': 70,
      'fair': 40
    }[info.accuracy];

    // RTF bonus
    const rtfBonus = Math.min((info.rtfSpeed || 1) * 5, 50);

    // Priority-based weighting
    switch (prefs.priority) {
      case 'speed':
        score = speedScore * 0.6 + accuracyScore * 0.2 + rtfBonus * 0.2;
        break;
      case 'accuracy':
        score = accuracyScore * 0.6 + speedScore * 0.2 + rtfBonus * 0.2;
        break;
      case 'balance':
      default:
        score = speedScore * 0.4 + accuracyScore * 0.4 + rtfBonus * 0.2;
        break;
    }

    // Platform-specific bonus
    if (prefs.platform === 'mobile' && info.type === 'moonshine') {
      score += 20; // Moonshine optimized for mobile
    }

    // English-only penalty for non-English requests
    if (prefs.language && prefs.language !== 'en' && info.languages.length === 1 && info.languages[0] === 'en') {
      score -= 50;
    }

    return score;
  }

  /**
   * Parse memory string to MB
   */
  private parseMemory(memory: string): number {
    const match = memory.match(/(\d+(?:\.\d+)?)\s*(MB|GB)/);
    if (!match) return Infinity;

    const value = parseFloat(match[1]);
    const unit = match[2];

    return unit === 'GB' ? value * 1024 : value;
  }

  /**
   * Get all available models with their info
   */
  getAvailableModels(): ModelInfo[] {
    return Array.from(this.availableModels.values()).map(m => m.getInfo());
  }

  /**
   * Get model by name
   */
  getModelByName(name: string): STTModel | undefined {
    return this.availableModels.get(name);
  }

  /**
   * Transcribe using auto-selected model
   */
  async transcribe(
    audioFilePath: string,
    options?: TranscriptionOptions,
    preferences?: RoutingPreferences
  ): Promise<TranscriptionResult & { modelUsed: string }> {
    const model = this.selectModel(preferences);
    const result = await model.transcribe(audioFilePath, options);

    return {
      ...result,
      modelUsed: model.getInfo().name
    };
  }
}

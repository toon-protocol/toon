/**
 * Unit tests for buildSkillDescriptor() (Story 5.4).
 *
 * Tests:
 * - T-5.4-04: Auto-population of kinds from handler registry
 * - T-5.4-05: Pricing derivation from kindPricing overrides and basePricePerByte
 * - T-5.4-20: Returns undefined when no DVM handlers registered
 * - T-5.4-21: getSkillDescriptor() on ServiceNode returns computed descriptor
 * - T-5.4-02: inputSchema follows JSON Schema draft-07
 * - T-5.4-03: Agent constructs valid Kind 5100 request using inputSchema
 * - T-5.4-06: Node publishes kind:10035 with skill descriptor on bootstrap
 * - T-5.4-07: Skill descriptor runtime update (stretch goal limitation documented)
 * - T-5.4-08: Agent discovery flow
 * - T-INT-05: Cross-story integration
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  buildServiceDiscoveryEvent,
  parseServiceDiscovery,
  buildJobRequestEvent,
  parseJobRequest,
  ToonError,
} from '@toon-protocol/core';
import type {
  ServiceDiscoveryContent,
  SkillDescriptor,
  HandlePacketRequest,
  HandlePacketResponse,
  EmbeddableConnectorLike,
  SendPacketParams,
  SendPacketResult,
  RegisterPeerParams,
} from '@toon-protocol/core';
import { HandlerRegistry } from './handler-registry.js';
import { buildSkillDescriptor } from './skill-descriptor.js';
import { createNode } from './create-node.js';

// Mock nostr-tools SimplePool to prevent live relay connections
vi.mock('nostr-tools', () => ({
  SimplePool: vi.fn(),
}));

// ============================================================================
// Mock Connector
// ============================================================================

function createMockConnector(): EmbeddableConnectorLike & {
  packetHandler:
    | ((
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>)
    | null;
} {
  return {
    packetHandler: null,
    async sendPacket(_params: SendPacketParams): Promise<SendPacketResult> {
      return { type: 'reject', code: 'F02', message: 'No route' };
    },
    async registerPeer(_params: RegisterPeerParams): Promise<void> {},
    async removePeer(_peerId: string): Promise<void> {},
    setPacketHandler(
      handler: (
        req: HandlePacketRequest
      ) => HandlePacketResponse | Promise<HandlePacketResponse>
    ): void {
      this.packetHandler = handler;
    },
  };
}

// ============================================================================
// Factories
// ============================================================================

function createServiceDiscoveryContentWithSkill(
  skill: SkillDescriptor
): ServiceDiscoveryContent {
  return {
    serviceType: 'relay',
    ilpAddress: 'g.toon.test-relay',
    pricing: {
      basePricePerByte: 10,
      currency: 'USDC',
    },
    supportedKinds: [1, 10032, 10035, 10036],
    capabilities: ['relay'],
    chain: 'anvil',
    version: '0.1.0',
    skill,
  };
}

// ============================================================================
// buildSkillDescriptor() Tests
// ============================================================================

describe('buildSkillDescriptor()', () => {
  // --------------------------------------------------------------------------
  // T-5.4-20: Returns undefined when no DVM handlers
  // --------------------------------------------------------------------------
  it('[P1] returns undefined when no DVM handlers registered (T-5.4-20)', () => {
    // Arrange: registry with no DVM handlers
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(1, handler); // non-DVM kind
    registry.on(10032, handler); // non-DVM kind

    // Act
    const result = buildSkillDescriptor(registry);

    // Assert
    expect(result).toBeUndefined();
  });

  it('[P1] returns undefined when registry is empty', () => {
    // Arrange
    const registry = new HandlerRegistry();

    // Act
    const result = buildSkillDescriptor(registry);

    // Assert
    expect(result).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // T-5.4-04: Auto-population of kinds from handler registry
  // --------------------------------------------------------------------------
  it('[P1] auto-populates kinds from handler registry (T-5.4-04)', () => {
    // Arrange: register DVM handlers
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);
    registry.on(5200, handler);

    // Act
    const result = buildSkillDescriptor(registry);

    // Assert
    expect(result).toBeDefined();
    expect(result!.kinds).toEqual([5100, 5200]);
  });

  it('[P1] excludes non-DVM kinds from skill descriptor', () => {
    // Arrange: mix of DVM and non-DVM handlers
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(1, handler);
    registry.on(5100, handler);
    registry.on(10032, handler);

    // Act
    const result = buildSkillDescriptor(registry);

    // Assert: only DVM kinds in descriptor
    expect(result).toBeDefined();
    expect(result!.kinds).toEqual([5100]);
  });

  // --------------------------------------------------------------------------
  // T-5.4-05: Pricing derivation
  // --------------------------------------------------------------------------
  it('[P1] derives pricing from kindPricing overrides (T-5.4-05)', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);
    registry.on(5200, handler);

    // Act: with per-kind pricing overrides
    const result = buildSkillDescriptor(registry, {
      kindPricing: { 5100: 1000000n, 5200: 5000000n },
      basePricePerByte: 10n,
    });

    // Assert: prices from overrides
    expect(result).toBeDefined();
    expect(result!.pricing).toEqual({
      '5100': '1000000',
      '5200': '5000000',
    });
  });

  it('[P1] falls back to basePricePerByte when no kindPricing override', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act: no kindPricing for 5100
    const result = buildSkillDescriptor(registry, {
      basePricePerByte: 42n,
    });

    // Assert: falls back to basePricePerByte
    expect(result).toBeDefined();
    expect(result!.pricing).toEqual({ '5100': '42' });
  });

  it('[P1] mixes kindPricing overrides and basePricePerByte fallback', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);
    registry.on(5200, handler);

    // Act: override only for 5100
    const result = buildSkillDescriptor(registry, {
      kindPricing: { 5100: 1000000n },
      basePricePerByte: 20n,
    });

    // Assert: 5100 from override, 5200 from basePricePerByte
    expect(result).toBeDefined();
    expect(result!.pricing).toEqual({
      '5100': '1000000',
      '5200': '20',
    });
  });

  it('[P1] uses default basePricePerByte (10n) when not specified', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act: no config
    const result = buildSkillDescriptor(registry);

    // Assert: default pricing
    expect(result).toBeDefined();
    expect(result!.pricing).toEqual({ '5100': '10' });
  });

  // --------------------------------------------------------------------------
  // Default field values
  // --------------------------------------------------------------------------
  it('[P1] uses default name and version when not overridden', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act
    const result = buildSkillDescriptor(registry);

    // Assert
    expect(result).toBeDefined();
    expect(result!.name).toBe('toon-dvm');
    expect(result!.version).toBe('1.0');
    expect(result!.features).toEqual([]);
    expect(result!.inputSchema).toEqual({
      type: 'object',
      properties: {},
    });
    expect(result!.models).toBeUndefined();
  });

  it('[P1] uses config overrides for name, version, features, inputSchema, models', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act
    const result = buildSkillDescriptor(registry, {
      name: 'my-dvm',
      version: '2.0',
      features: ['text-generation', 'streaming'],
      inputSchema: {
        type: 'object',
        properties: { prompt: { type: 'string' } },
        required: ['prompt'],
      },
      models: ['gpt-4', 'claude-3'],
    });

    // Assert: all overrides applied
    expect(result).toBeDefined();
    expect(result!.name).toBe('my-dvm');
    expect(result!.version).toBe('2.0');
    expect(result!.features).toEqual(['text-generation', 'streaming']);
    expect(result!.inputSchema).toEqual({
      type: 'object',
      properties: { prompt: { type: 'string' } },
      required: ['prompt'],
    });
    expect(result!.models).toEqual(['gpt-4', 'claude-3']);
  });
});

// ============================================================================
// T-5.4-02: inputSchema follows JSON Schema draft-07
// ============================================================================

describe('inputSchema JSON Schema compliance (T-5.4-02)', () => {
  it('[P1] inputSchema is a valid JSON Schema draft-07 object', () => {
    // Arrange: build a skill descriptor with a JSON Schema compliant inputSchema
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1 },
        maxTokens: { type: 'number', minimum: 1, maximum: 4096 },
        temperature: { type: 'number', minimum: 0, maximum: 2 },
      },
      required: ['prompt'],
      additionalProperties: false,
    };

    const result = buildSkillDescriptor(registry, { inputSchema: schema });

    // Assert: structural JSON Schema draft-07 validation
    expect(result).toBeDefined();
    const is = result!.inputSchema;
    expect(typeof is).toBe('object');
    expect(is).not.toBeNull();
    expect(is['type']).toBe('object');
    expect(is['properties']).toBeDefined();
    expect(typeof is['properties']).toBe('object');
  });
});

// ============================================================================
// T-5.4-03: Agent constructs valid Kind 5100 request using inputSchema
// ============================================================================

describe('Agent constructs job request from inputSchema (T-5.4-03)', () => {
  it('[P1] agent reads inputSchema -> constructs valid Kind 5100 request', () => {
    // Arrange: build a skill descriptor with inputSchema
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    const skill = buildSkillDescriptor(registry, {
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          maxTokens: { type: 'number' },
        },
        required: ['prompt'],
      },
    });
    expect(skill).toBeDefined();

    // Act: agent reads schema and constructs a Kind 5100 request
    // The inputSchema tells the agent what param tags to include
    const schemaProperties = skill!.inputSchema['properties'] as Record<
      string,
      unknown
    >;
    const requiredFields = skill!.inputSchema['required'] as string[];

    // Agent constructs param tags from schema properties
    const params: { key: string; value: string }[] = [];
    for (const [key] of Object.entries(schemaProperties)) {
      if (requiredFields.includes(key)) {
        // Agent provides required fields
        if (key === 'prompt') {
          params.push({ key, value: 'Explain quantum computing' });
        }
      } else {
        // Agent optionally provides other fields
        if (key === 'maxTokens') {
          params.push({ key, value: '1024' });
        }
      }
    }

    const customerSecretKey = generateSecretKey();
    const jobEvent = buildJobRequestEvent(
      {
        kind: 5100,
        input: { data: 'Explain quantum computing', type: 'text' },
        bid: '1000000',
        output: 'text/plain',
        params,
      },
      customerSecretKey
    );

    // Assert: parseJobRequest() successfully parses the result
    const parsed = parseJobRequest(jobEvent);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe(5100);
    expect(parsed!.input.data).toBe('Explain quantum computing');
    expect(parsed!.params).toContainEqual({
      key: 'prompt',
      value: 'Explain quantum computing',
    });
    expect(parsed!.params).toContainEqual({
      key: 'maxTokens',
      value: '1024',
    });
  });
});

// ============================================================================
// T-5.4-08: Agent discovery -- filter by skill.kinds, compare pricing
// ============================================================================

describe('Agent discovery flow (T-5.4-08)', () => {
  it('[P1] agent queries kind:10035 events -> filters by skill.kinds -> compares pricing', () => {
    // Arrange: simulate multiple providers with different skill descriptors
    const providerASecretKey = generateSecretKey();
    const providerBSecretKey = generateSecretKey();

    const providerAContent = createServiceDiscoveryContentWithSkill({
      name: 'provider-a',
      version: '1.0',
      kinds: [5100, 5200],
      features: ['text-generation', 'image-generation'],
      inputSchema: { type: 'object', properties: {} },
      pricing: { '5100': '1000000', '5200': '5000000' },
      models: ['gpt-4'],
    });

    const providerBContent = createServiceDiscoveryContentWithSkill({
      name: 'provider-b',
      version: '1.0',
      kinds: [5100],
      features: ['text-generation', 'streaming'],
      inputSchema: { type: 'object', properties: {} },
      pricing: { '5100': '500000' },
      models: ['claude-3'],
    });

    const eventA = buildServiceDiscoveryEvent(
      providerAContent,
      providerASecretKey
    );
    const eventB = buildServiceDiscoveryEvent(
      providerBContent,
      providerBSecretKey
    );

    // Act: parse events and filter
    const parsedA = parseServiceDiscovery(eventA);
    const parsedB = parseServiceDiscovery(eventB);
    expect(parsedA).not.toBeNull();
    expect(parsedB).not.toBeNull();

    // Agent filters by skill.kinds containing 5100
    const providers = [parsedA!, parsedB!].filter(
      (p) => p.skill && p.skill.kinds.includes(5100)
    );

    // Assert: both providers support 5100
    expect(providers).toHaveLength(2);

    // Agent compares pricing for kind 5100
    const priceA = providers[0]!.skill!.pricing['5100'];
    const priceB = providers[1]!.skill!.pricing['5100'];
    expect(priceA).toBe('1000000');
    expect(priceB).toBe('500000');

    // Agent selects cheapest provider
    const cheapest = providers.reduce((best, current) => {
      const bestPrice = BigInt(best.skill!.pricing['5100']!);
      const currentPrice = BigInt(current.skill!.pricing['5100']!);
      return currentPrice < bestPrice ? current : best;
    });
    expect(cheapest.skill!.name).toBe('provider-b');
    expect(cheapest.skill!.pricing['5100']).toBe('500000');
  });

  it('[P1] agent filters by features and models', () => {
    // Arrange
    const secretKey = generateSecretKey();
    const content = createServiceDiscoveryContentWithSkill({
      name: 'toon-dvm',
      version: '1.0',
      kinds: [5100],
      features: ['text-generation', 'streaming'],
      inputSchema: { type: 'object', properties: {} },
      pricing: { '5100': '1000000' },
      models: ['gpt-4', 'claude-3'],
    });

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);
    expect(parsed).not.toBeNull();

    // Assert: agent can filter by features
    expect(parsed!.skill!.features).toContain('streaming');
    expect(parsed!.skill!.models).toContain('claude-3');
  });
});

// ============================================================================
// T-INT-05: Cross-story integration -- schema-driven request construction
// ============================================================================

describe('Cross-story integration: schema to request (T-INT-05)', () => {
  it('[P1] agent reads skill -> constructs request using inputSchema -> validates via parseJobRequest', () => {
    // Arrange: provider publishes kind:10035 with skill descriptor
    const providerSecretKey = generateSecretKey();
    const customerSecretKey = generateSecretKey();

    const skill = buildSkillDescriptor(
      (() => {
        const reg = new HandlerRegistry();
        const handler = vi.fn().mockResolvedValue({ accept: true });
        reg.on(5100, handler);
        return reg;
      })(),
      {
        name: 'toon-dvm',
        features: ['text-generation'],
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            maxTokens: { type: 'number' },
            model: { type: 'string' },
          },
          required: ['prompt'],
        },
        models: ['gpt-4', 'claude-3'],
        basePricePerByte: 10n,
      }
    );
    expect(skill).toBeDefined();

    const content = createServiceDiscoveryContentWithSkill(skill!);
    const discoveryEvent = buildServiceDiscoveryEvent(
      content,
      providerSecretKey
    );
    const parsed = parseServiceDiscovery(discoveryEvent);
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();

    // Act: agent reads skill descriptor and constructs request
    const discoveredSkill = parsed!.skill!;
    const requestKind = discoveredSkill.kinds[0]!;
    expect(requestKind).toBe(5100);

    // Agent uses inputSchema to construct param tags
    const jobEvent = buildJobRequestEvent(
      {
        kind: requestKind,
        input: { data: 'What is quantum computing?', type: 'text' },
        bid: discoveredSkill.pricing[String(requestKind)]!,
        output: 'text/plain',
        params: [
          { key: 'prompt', value: 'What is quantum computing?' },
          { key: 'maxTokens', value: '2048' },
          { key: 'model', value: 'claude-3' },
        ],
      },
      customerSecretKey
    );

    // Assert: parseJobRequest() successfully parses the constructed request
    const parsedRequest = parseJobRequest(jobEvent);
    expect(parsedRequest).not.toBeNull();
    expect(parsedRequest!.kind).toBe(5100);
    expect(parsedRequest!.bid).toBe(discoveredSkill.pricing['5100']);
    expect(parsedRequest!.params).toContainEqual({
      key: 'prompt',
      value: 'What is quantum computing?',
    });
    expect(parsedRequest!.params).toContainEqual({
      key: 'maxTokens',
      value: '2048',
    });
    expect(parsedRequest!.params).toContainEqual({
      key: 'model',
      value: 'claude-3',
    });
  });
});

// ============================================================================
// T-5.4-10: Build -> parse roundtrip with skill descriptor (via buildSkillDescriptor)
// ============================================================================

describe('Build -> parse roundtrip (T-5.4-10 via buildSkillDescriptor)', () => {
  it('[P1] skill descriptor roundtrips through build/parse', () => {
    // Arrange: build descriptor from registry
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);
    registry.on(5200, handler);

    const skill = buildSkillDescriptor(registry, {
      name: 'test-dvm',
      version: '2.0',
      features: ['text-generation', 'image-generation'],
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          style: { type: 'string', enum: ['realistic', 'cartoon'] },
        },
        required: ['prompt'],
      },
      models: ['dall-e-3'],
      kindPricing: { 5100: 1000000n, 5200: 5000000n },
    });
    expect(skill).toBeDefined();

    // Act: embed in kind:10035 event and roundtrip
    const secretKey = generateSecretKey();
    const content = createServiceDiscoveryContentWithSkill(skill!);
    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: all fields preserved
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.name).toBe('test-dvm');
    expect(parsed!.skill!.version).toBe('2.0');
    expect(parsed!.skill!.kinds).toEqual([5100, 5200]);
    expect(parsed!.skill!.features).toEqual([
      'text-generation',
      'image-generation',
    ]);
    expect(parsed!.skill!.pricing).toEqual({
      '5100': '1000000',
      '5200': '5000000',
    });
    expect(parsed!.skill!.models).toEqual(['dall-e-3']);
    expect(parsed!.skill!.inputSchema).toEqual({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        style: { type: 'string', enum: ['realistic', 'cartoon'] },
      },
      required: ['prompt'],
    });
  });
});

// ============================================================================
// T-5.4-21: ServiceNode.getSkillDescriptor() returns computed descriptor
// ============================================================================

describe('ServiceNode.getSkillDescriptor() (T-5.4-21)', () => {
  it('[P1] returns computed skill descriptor when DVM handlers registered', () => {
    // Arrange: create node with DVM handler
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      basePricePerByte: 100n,
      kindPricing: { 5100: 2000000n },
      skillConfig: {
        name: 'my-dvm',
        features: ['text-generation'],
        inputSchema: {
          type: 'object',
          properties: { prompt: { type: 'string' } },
        },
        models: ['gpt-4'],
      },
    });

    // Register DVM handler AFTER creation via .on()
    node.on(5100, handler);

    // Act
    const skill = node.getSkillDescriptor();

    // Assert
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('my-dvm');
    expect(skill!.version).toBe('1.0');
    expect(skill!.kinds).toEqual([5100]);
    expect(skill!.features).toEqual(['text-generation']);
    expect(skill!.pricing).toEqual({ '5100': '2000000' });
    expect(skill!.models).toEqual(['gpt-4']);
    expect(skill!.inputSchema).toEqual({
      type: 'object',
      properties: { prompt: { type: 'string' } },
    });
  });

  it('[P1] returns undefined when no DVM handlers registered', () => {
    // Arrange: create node without DVM handlers
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    const node = createNode({
      secretKey,
      connector,
    });

    // Act
    const skill = node.getSkillDescriptor();

    // Assert
    expect(skill).toBeUndefined();
  });

  it('[P1] reflects handlers registered via config', () => {
    // Arrange: create node with DVM handler in config
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      handlers: { 5100: handler, 5200: handler },
    });

    // Act
    const skill = node.getSkillDescriptor();

    // Assert: both config-registered DVM kinds appear
    expect(skill).toBeDefined();
    expect(skill!.kinds).toEqual([5100, 5200]);
  });
});

// ============================================================================
// T-5.4-06: Node publishes kind:10035 with skill descriptor on bootstrap (P1)
//
// This behavioral test exercises the full composition path:
// createNode() with DVM handlers + skillConfig
//   -> getSkillDescriptor() produces descriptor
//     -> buildServiceDiscoveryEvent() includes skill in content
//       -> parseServiceDiscovery() recovers all skill fields
//
// This validates the end-to-end data flow that Town's startTown() uses
// at bootstrap completion. The actual Town publication is verified by
// static analysis tests in town.test.ts; this test proves the SDK -> Core
// composition produces correct output.
// ============================================================================

describe('Node publishes kind:10035 with skill descriptor (T-5.4-06)', () => {
  it('[P1] ServiceNode.getSkillDescriptor() output is correctly embedded in kind:10035 event', () => {
    // Arrange: create node with DVM handlers and skill config
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      basePricePerByte: 100n,
      kindPricing: { 5100: 2000000n, 5200: 5000000n },
      skillConfig: {
        name: 'test-provider',
        version: '1.0',
        features: ['text-generation', 'image-generation'],
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            maxTokens: { type: 'number' },
          },
          required: ['prompt'],
        },
        models: ['gpt-4', 'claude-3'],
      },
    });
    node.on(5100, handler);
    node.on(5200, handler);

    // Act: get skill descriptor (same API Town uses at bootstrap)
    const skill = node.getSkillDescriptor();
    expect(skill).toBeDefined();

    // Act: simulate Town's kind:10035 publication path
    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test-provider',
      pricing: { basePricePerByte: 100, currency: 'USDC' },
      supportedKinds: [1, 5100, 5200, 10032, 10035, 10036],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
      skill: skill!,
    };

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: kind:10035 event contains full skill descriptor
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.name).toBe('test-provider');
    expect(parsed!.skill!.version).toBe('1.0');
    expect(parsed!.skill!.kinds).toEqual([5100, 5200]);
    expect(parsed!.skill!.features).toEqual([
      'text-generation',
      'image-generation',
    ]);
    expect(parsed!.skill!.pricing).toEqual({
      '5100': '2000000',
      '5200': '5000000',
    });
    expect(parsed!.skill!.models).toEqual(['gpt-4', 'claude-3']);
    expect(parsed!.skill!.inputSchema).toEqual({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        maxTokens: { type: 'number' },
      },
      required: ['prompt'],
    });
  });

  it('[P1] kind:10035 event omits skill field when no DVM handlers registered', () => {
    // Arrange: create node with NO DVM handlers
    const secretKey = generateSecretKey();
    const connector = createMockConnector();

    const node = createNode({
      secretKey,
      connector,
    });

    // Act: get skill descriptor
    const skill = node.getSkillDescriptor();
    expect(skill).toBeUndefined();

    // Act: build kind:10035 without skill (backward compatible)
    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 10032, 10036],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
    };

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: kind:10035 event has no skill field (pre-DVM backward compatibility)
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeUndefined();
    expect(parsed!.serviceType).toBe('relay');
  });

  it('[P1] kind:10035 event includes both TOON-specific fields and skill descriptor', () => {
    // Arrange: full-featured kind:10035 with x402 + skill
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      skillConfig: {
        features: ['text-generation'],
      },
    });
    node.on(5100, handler);

    const skill = node.getSkillDescriptor();
    expect(skill).toBeDefined();

    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      x402: { enabled: true, endpoint: '/publish' },
      supportedKinds: [1, 5100, 10032, 10035, 10036],
      capabilities: ['relay', 'x402'],
      chain: 'arbitrum-one',
      version: '0.1.0',
      skill: skill!,
    };

    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: all fields present (TOON-specific + skill)
    expect(parsed).not.toBeNull();
    expect(parsed!.ilpAddress).toBe('g.toon.test');
    expect(parsed!.x402).toBeDefined();
    expect(parsed!.x402!.enabled).toBe(true);
    expect(parsed!.x402!.endpoint).toBe('/publish');
    expect(parsed!.chain).toBe('arbitrum-one');
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.kinds).toEqual([5100]);
    expect(parsed!.skill!.features).toEqual(['text-generation']);
  });
});

// ============================================================================
// T-5.4-07: Skill descriptor update on runtime handler registration (P2)
//
// AC #4 scope note: Runtime re-publication of kind:10035 is a stretch goal.
// The primary path is auto-population at bootstrap time. The tests below
// verify that getSkillDescriptor() reads live from the handler registry
// (so newly added handlers ARE reflected in the descriptor), but note that
// no automatic kind:10035 re-publication occurs when handlers change at
// runtime. The limitation is documented here per AC #4.
// ============================================================================

describe('Skill descriptor runtime update (T-5.4-07)', () => {
  it('[P2] getSkillDescriptor() dynamically reflects handlers added after createNode()', () => {
    // Arrange: create node with no DVM handlers
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
    });

    // Act: initially no DVM handlers
    expect(node.getSkillDescriptor()).toBeUndefined();

    // Act: add DVM handler at runtime
    node.on(5100, handler);

    // Assert: getSkillDescriptor() now reflects the new handler
    const skill = node.getSkillDescriptor();
    expect(skill).toBeDefined();
    expect(skill!.kinds).toEqual([5100]);
  });

  it('[P2] getSkillDescriptor() reflects multiple handlers added incrementally', () => {
    // Arrange: create node with one DVM handler
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
    });
    node.on(5100, handler);

    // Act: verify initial state
    const skill1 = node.getSkillDescriptor();
    expect(skill1).toBeDefined();
    expect(skill1!.kinds).toEqual([5100]);

    // Act: add another DVM handler
    node.on(5200, handler);

    // Assert: descriptor updated with both kinds
    const skill2 = node.getSkillDescriptor();
    expect(skill2).toBeDefined();
    expect(skill2!.kinds).toEqual([5100, 5200]);
  });

  it('[P2] documents limitation: no automatic kind:10035 re-publication on handler change', () => {
    // This test documents the AC #4 scope limitation:
    // getSkillDescriptor() reads live from the registry, but there is no
    // automatic mechanism to re-publish a kind:10035 event when handlers
    // change at runtime. Applications that need updated discovery must
    // manually call getSkillDescriptor() and publish a new kind:10035.
    //
    // The primary path (bootstrap-time population) is validated by T-5.4-06.
    // Runtime re-publication was identified as a stretch goal because
    // node.on() is typically called before start().

    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({ secretKey, connector });
    node.on(5100, handler);

    // getSkillDescriptor() returns the live state -- this is the API
    // that Town can use to build updated kind:10035 events manually.
    const skill = node.getSkillDescriptor();
    expect(skill).toBeDefined();
    expect(skill!.kinds).toEqual([5100]);

    // The ServiceNode interface exposes getSkillDescriptor() but does NOT
    // expose a publishServiceDiscovery() method. Re-publication is the
    // caller's responsibility (e.g., Town's startTown()).
    expect(typeof node.getSkillDescriptor).toBe('function');
  });
});

// ============================================================================
// Backward compatibility: kind:10035 without skill parses correctly
// ============================================================================

describe('Backward compatibility (T-5.4-12 via buildSkillDescriptor)', () => {
  it('[P0] kind:10035 event without skill field parses correctly', () => {
    // Arrange: standard kind:10035 content without skill
    const secretKey = generateSecretKey();
    const content: ServiceDiscoveryContent = {
      serviceType: 'relay',
      ilpAddress: 'g.toon.test',
      pricing: { basePricePerByte: 10, currency: 'USDC' },
      supportedKinds: [1, 10032, 10036],
      capabilities: ['relay'],
      chain: 'anvil',
      version: '0.1.0',
    };

    // Act
    const event = buildServiceDiscoveryEvent(content, secretKey);
    const parsed = parseServiceDiscovery(event);

    // Assert: parses without skill field
    expect(parsed).not.toBeNull();
    expect(parsed!.serviceType).toBe('relay');
    expect(parsed!.skill).toBeUndefined();
  });
});

// ============================================================================
// Story 6.3 Task 4: Skill descriptor attestation field
// ============================================================================

describe('Skill descriptor attestation field (Story 6.3 Task 4)', () => {
  const ATTESTATION_EVENT_ID = 'e'.repeat(64);
  const ENCLAVE_IMAGE_HASH = 'abc123def456';

  // --------------------------------------------------------------------------
  // T-6.3-10 [P1]: TEE-attested node's kind:10035 includes attestation field
  // --------------------------------------------------------------------------
  it('[P1] TEE-attested node skill descriptor includes attestation field (T-6.3-10)', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act
    const result = buildSkillDescriptor(registry, {
      attestation: {
        eventId: ATTESTATION_EVENT_ID,
        enclaveImageHash: ENCLAVE_IMAGE_HASH,
      },
    });

    // Assert
    expect(result).toBeDefined();
    expect(result!.attestation).toBeDefined();
    expect(result!.attestation!['eventId']).toBe(ATTESTATION_EVENT_ID);
    expect(result!.attestation!['enclaveImageHash']).toBe(ENCLAVE_IMAGE_HASH);
  });

  // --------------------------------------------------------------------------
  // T-6.3-10 supplement: attestation roundtrips through kind:10035
  // --------------------------------------------------------------------------
  it('[P1] attestation field roundtrips through kind:10035 build/parse', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    const skill = buildSkillDescriptor(registry, {
      attestation: {
        eventId: ATTESTATION_EVENT_ID,
        enclaveImageHash: ENCLAVE_IMAGE_HASH,
      },
    });
    expect(skill).toBeDefined();

    const secretKey = generateSecretKey();
    const content = createServiceDiscoveryContentWithSkill(skill!);
    const event = buildServiceDiscoveryEvent(content, secretKey);

    // Act
    const parsed = parseServiceDiscovery(event);

    // Assert
    expect(parsed).not.toBeNull();
    expect(parsed!.skill).toBeDefined();
    expect(parsed!.skill!.attestation).toBeDefined();
    expect(parsed!.skill!.attestation!['eventId']).toBe(ATTESTATION_EVENT_ID);
    expect(parsed!.skill!.attestation!['enclaveImageHash']).toBe(
      ENCLAVE_IMAGE_HASH
    );
  });

  // --------------------------------------------------------------------------
  // Non-TEE node has no attestation field (backward compatible)
  // --------------------------------------------------------------------------
  it('[P1] non-TEE node skill descriptor has no attestation field', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act: no attestation config
    const result = buildSkillDescriptor(registry);

    // Assert
    expect(result).toBeDefined();
    expect(result!.attestation).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // T-6.3-11 [P1]: Customer filters by attestation field presence
  // --------------------------------------------------------------------------
  it('[P1] customer filters skill descriptors by attestation field presence (T-6.3-11)', () => {
    // Arrange: two providers -- one with attestation, one without
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    const attestedSkill = buildSkillDescriptor(registry, {
      name: 'attested-provider',
      attestation: {
        eventId: ATTESTATION_EVENT_ID,
        enclaveImageHash: ENCLAVE_IMAGE_HASH,
      },
    });

    const nonAttestedSkill = buildSkillDescriptor(registry, {
      name: 'non-attested-provider',
    });

    expect(attestedSkill).toBeDefined();
    expect(nonAttestedSkill).toBeDefined();

    // Act: filter by attestation presence
    const allSkills = [attestedSkill!, nonAttestedSkill!];
    const attestedOnly = allSkills.filter((s) => s.attestation !== undefined);

    // Assert
    expect(attestedOnly).toHaveLength(1);
    expect(attestedOnly[0]!.name).toBe('attested-provider');
  });

  // --------------------------------------------------------------------------
  // AC #4 integration: createNode with attestation config -> getSkillDescriptor
  // --------------------------------------------------------------------------
  it('[P1] createNode with skillConfig.attestation -> getSkillDescriptor includes attestation field', () => {
    // Arrange: create node with attestation in skillConfig
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      skillConfig: {
        name: 'tee-provider',
        attestation: {
          eventId: ATTESTATION_EVENT_ID,
          enclaveImageHash: ENCLAVE_IMAGE_HASH,
        },
      },
    });
    node.on(5100, handler);

    // Act
    const skill = node.getSkillDescriptor();

    // Assert
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('tee-provider');
    expect(skill!.attestation).toBeDefined();
    expect(skill!.attestation!['eventId']).toBe(ATTESTATION_EVENT_ID);
    expect(skill!.attestation!['enclaveImageHash']).toBe(ENCLAVE_IMAGE_HASH);
  });

  it('[P1] createNode without attestation config -> getSkillDescriptor has no attestation field', () => {
    // Arrange: create node without attestation
    const secretKey = generateSecretKey();
    const connector = createMockConnector();
    const handler = vi.fn().mockResolvedValue({ accept: true });

    const node = createNode({
      secretKey,
      connector,
      skillConfig: {
        name: 'non-tee-provider',
      },
    });
    node.on(5100, handler);

    // Act
    const skill = node.getSkillDescriptor();

    // Assert
    expect(skill).toBeDefined();
    expect(skill!.name).toBe('non-tee-provider');
    expect(skill!.attestation).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Validation: invalid attestation eventId
  // --------------------------------------------------------------------------
  it('throws ToonError with DVM_SKILL_INVALID_ATTESTATION_EVENT_ID for invalid eventId', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act & Assert
    let thrown: unknown;
    try {
      buildSkillDescriptor(registry, {
        attestation: {
          eventId: 'not-valid-hex',
          enclaveImageHash: ENCLAVE_IMAGE_HASH,
        },
      });
      expect.unreachable('Expected buildSkillDescriptor to throw');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToonError);
    expect((thrown as ToonError).code).toBe(
      'DVM_SKILL_INVALID_ATTESTATION_EVENT_ID'
    );
  });

  it('throws for uppercase hex attestation eventId', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act & Assert
    expect(() =>
      buildSkillDescriptor(registry, {
        attestation: {
          eventId: 'E'.repeat(64),
          enclaveImageHash: ENCLAVE_IMAGE_HASH,
        },
      })
    ).toThrow(ToonError);
  });

  it('throws for too-short attestation eventId', () => {
    // Arrange
    const registry = new HandlerRegistry();
    const handler = vi.fn().mockResolvedValue({ accept: true });
    registry.on(5100, handler);

    // Act & Assert
    expect(() =>
      buildSkillDescriptor(registry, {
        attestation: {
          eventId: 'e'.repeat(63),
          enclaveImageHash: ENCLAVE_IMAGE_HASH,
        },
      })
    ).toThrow(ToonError);
  });
});

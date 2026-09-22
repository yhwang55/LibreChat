import React from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import Part from '../Part';

jest.mock('../Parts', () => ({
  ImageGen: () => <div data-testid="image-gen" />,
  ExecuteCode: () => <div data-testid="execute-code" />,
  AgentUpdate: () => <div data-testid="agent-update" />,
  EmptyText: () => <div data-testid="empty-text" />,
  Reasoning: () => <div data-testid="reasoning" />,
  ReasoningMarker: () => <div data-testid="reasoning-marker" />,
  Summary: () => <div data-testid="summary" />,
  Text: ({ text }: { text?: string }) => <div data-testid="text">{text}</div>,
  SkillCall: () => <div data-testid="skill-call" />,
  MemoryCall: () => <div data-testid="memory-call" />,
  ReadFileCall: () => <div data-testid="read-file-call" />,
  FileAuthoringCall: () => <div data-testid="file-authoring-call" />,
  BashCall: () => <div data-testid="bash-call" />,
  SubagentCall: () => <div data-testid="subagent-call" />,
  SteerPart: () => <div data-testid="steer-part" />,
}));

jest.mock('../ProductCards', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <div data-testid="product-cards">{text}</div>,
}));

jest.mock('../MessageContent', () => ({ ErrorMessage: () => <div /> }));
jest.mock('../RetrievalCall', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../AgentHandoff', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../CodeAnalyze', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../WebSearch', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../ToolCall', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../Image', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../AskUserQuestion', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../AskUserQuestionCall', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../ToolApproval', () => ({ __esModule: true, default: () => <div /> }));
jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/utils', () => ({
  getCachedPreview: jest.fn(),
  getActivityLabelPart: jest.fn(),
  getActivityLabelText: jest.fn(),
}));
jest.mock('~/utils/approval', () => ({ getAskUserQuestionPart: jest.fn(() => null) }));
jest.mock('../routing', () => ({ isBashProgrammaticToolCall: jest.fn(() => false) }));

const textPart = {
  type: ContentTypes.TEXT,
  text: 'Here are some great running shoes for marathon training.',
} as TMessageContentParts;

describe('Part → ProductCards mounting', () => {
  it('mounts product cards on the settled newest message (holds cursor, not submitting)', () => {
    render(
      <Part
        part={textPart}
        isSubmitting={false}
        showCursor={true}
        isCreatedByUser={false}
        isLast
      />,
    );

    expect(screen.getByTestId('product-cards')).toBeInTheDocument();
  });

  it('withholds product cards while the response is still streaming', () => {
    render(
      <Part part={textPart} isSubmitting={true} showCursor={true} isCreatedByUser={false} isLast />,
    );

    expect(screen.queryByTestId('product-cards')).not.toBeInTheDocument();
  });

  it('mounts product cards on an older assistant message', () => {
    render(
      <Part part={textPart} isSubmitting={false} showCursor={false} isCreatedByUser={false} />,
    );

    expect(screen.getByTestId('product-cards')).toBeInTheDocument();
  });

  it('never mounts product cards on a user message', () => {
    render(<Part part={textPart} isSubmitting={false} showCursor={false} isCreatedByUser={true} />);

    expect(screen.queryByTestId('product-cards')).not.toBeInTheDocument();
  });
});

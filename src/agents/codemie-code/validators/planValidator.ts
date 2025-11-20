/**
 * Plan Validator
 *
 * Validates the quality and completeness of generated plans
 * Ensures plans follow best practices for structured execution
 */

import type { Todo } from '../types.js';
import { validateTodoList, type TodoListValidationResult } from '../utils/todoValidator.js';

/**
 * Plan validation criteria
 */
export interface PlanValidationCriteria {
  /** Minimum number of steps required */
  minSteps: number;

  /** Maximum number of steps allowed */
  maxSteps: number;

  /** Minimum quality score (0-100) */
  minQualityScore: number;

  /** Required step patterns */
  requiredPatterns: {
    /** Must include discovery/analysis steps */
    discovery: boolean;

    /** Must include implementation steps */
    implementation: boolean;

    /** Must include testing/verification steps */
    testing: boolean;

    /** Must include completion/documentation steps */
    completion: boolean;
  };

  /** Task-specific requirements */
  taskSpecific: {
    /** Must reference specific files or components */
    specificReferences: boolean;

    /** Must use action verbs */
    actionVerbs: boolean;

    /** Must have clear completion criteria */
    completionCriteria: boolean;
  };
}

/**
 * Comprehensive plan validation result
 */
export interface PlanValidationResult extends TodoListValidationResult {
  /** Whether plan meets all criteria */
  meetsCriteria: boolean;

  /** Detailed criteria assessment */
  criteriaAssessment: {
    stepCount: { valid: boolean; actual: number; required: string };
    qualityScore: { valid: boolean; actual: number; required: number };
    patterns: { [key: string]: { found: boolean; description: string } };
    taskSpecific: { [key: string]: { valid: boolean; description: string } };
  };

  /** Plan type detected */
  detectedType: 'feature' | 'bugfix' | 'analysis' | 'mixed';

  /** Confidence in plan quality (0-100) */
  confidence: number;

  /** Recommended improvements */
  improvements: string[];
}

/**
 * Default validation criteria for different plan types
 */
const DEFAULT_CRITERIA: Record<string, PlanValidationCriteria> = {
  feature: {
    minSteps: 3,
    maxSteps: 8,
    minQualityScore: 70,
    requiredPatterns: {
      discovery: true,
      implementation: true,
      testing: true,
      completion: true
    },
    taskSpecific: {
      specificReferences: true,
      actionVerbs: true,
      completionCriteria: true
    }
  },
  bugfix: {
    minSteps: 3,
    maxSteps: 6,
    minQualityScore: 75,
    requiredPatterns: {
      discovery: true,
      implementation: true,
      testing: true,
      completion: false
    },
    taskSpecific: {
      specificReferences: true,
      actionVerbs: true,
      completionCriteria: true
    }
  },
  analysis: {
    minSteps: 3,
    maxSteps: 10,
    minQualityScore: 65,
    requiredPatterns: {
      discovery: true,
      implementation: false,
      testing: false,
      completion: true
    },
    taskSpecific: {
      specificReferences: false,
      actionVerbs: true,
      completionCriteria: false
    }
  }
};

/**
 * Validate a plan against comprehensive criteria
 */
export function validatePlan(
  todos: Todo[],
  planType: 'feature' | 'bugfix' | 'analysis' = 'feature',
  customCriteria?: Partial<PlanValidationCriteria>
): PlanValidationResult {
  // Get base validation from todo validator
  const baseValidation = validateTodoList(todos);

  // Get criteria for plan type
  const criteria = {
    ...DEFAULT_CRITERIA[planType],
    ...customCriteria
  };

  // Detect actual plan type
  const detectedType = detectPlanType(todos);

  // Assess criteria
  const criteriaAssessment = assessCriteria(todos, criteria);

  // Calculate confidence
  const confidence = calculateConfidence(baseValidation, criteriaAssessment);

  // Check if all criteria are met
  const meetsCriteria =
    baseValidation.isValid &&
    criteriaAssessment.stepCount.valid &&
    criteriaAssessment.qualityScore.valid &&
    Object.values(criteriaAssessment.patterns).every(p => p.found) &&
    Object.values(criteriaAssessment.taskSpecific).every(t => t.valid);

  // Generate improvements
  const improvements = generateImprovements(baseValidation, criteriaAssessment, criteria);

  return {
    ...baseValidation,
    meetsCriteria,
    criteriaAssessment,
    detectedType,
    confidence,
    improvements
  };
}

/**
 * Detect plan type from todo content
 */
function detectPlanType(todos: Todo[]): 'feature' | 'bugfix' | 'analysis' | 'mixed' {
  const allContent = todos.map(t => t.content.toLowerCase()).join(' ');

  let featureScore = 0;
  let bugfixScore = 0;
  let analysisScore = 0;

  // Feature indicators
  const featureWords = ['create', 'add', 'implement', 'build', 'develop', 'design', 'new'];
  featureScore = featureWords.filter(word => allContent.includes(word)).length;

  // Bugfix indicators
  const bugfixWords = ['fix', 'repair', 'resolve', 'debug', 'issue', 'error', 'bug'];
  bugfixScore = bugfixWords.filter(word => allContent.includes(word)).length;

  // Analysis indicators
  const analysisWords = ['analyze', 'review', 'understand', 'explore', 'examine', 'assess'];
  analysisScore = analysisWords.filter(word => allContent.includes(word)).length;

  // Determine type
  if (featureScore > bugfixScore && featureScore > analysisScore) return 'feature';
  if (bugfixScore > featureScore && bugfixScore > analysisScore) return 'bugfix';
  if (analysisScore > featureScore && analysisScore > bugfixScore) return 'analysis';

  return 'mixed';
}

/**
 * Assess plan against specific criteria
 */
function assessCriteria(todos: Todo[], criteria: PlanValidationCriteria) {
  const allContent = todos.map(t => t.content.toLowerCase()).join(' ');

  // Step count assessment
  const stepCount = {
    valid: todos.length >= criteria.minSteps && todos.length <= criteria.maxSteps,
    actual: todos.length,
    required: `${criteria.minSteps}-${criteria.maxSteps}`
  };

  // Quality score assessment (from base validation)
  const baseValidation = validateTodoList(todos);
  const qualityScore = {
    valid: baseValidation.overallQuality >= criteria.minQualityScore,
    actual: baseValidation.overallQuality,
    required: criteria.minQualityScore
  };

  // Pattern assessment
  const patterns: Record<string, { found: boolean; description: string }> = {};

  if (criteria.requiredPatterns.discovery) {
    const discoveryWords = ['read', 'analyze', 'explore', 'understand', 'examine', 'review', 'investigate'];
    patterns.discovery = {
      found: discoveryWords.some(word => allContent.includes(word)),
      description: 'Plan should include discovery/analysis steps'
    };
  }

  if (criteria.requiredPatterns.implementation) {
    const implWords = ['create', 'write', 'implement', 'build', 'modify', 'update', 'add', 'develop'];
    patterns.implementation = {
      found: implWords.some(word => allContent.includes(word)),
      description: 'Plan should include implementation steps'
    };
  }

  if (criteria.requiredPatterns.testing) {
    const testWords = ['test', 'verify', 'validate', 'check', 'run'];
    patterns.testing = {
      found: testWords.some(word => allContent.includes(word)),
      description: 'Plan should include testing/verification steps'
    };
  }

  if (criteria.requiredPatterns.completion) {
    const compWords = ['commit', 'document', 'summary', 'complete', 'finalize'];
    patterns.completion = {
      found: compWords.some(word => allContent.includes(word)),
      description: 'Plan should include completion/documentation steps'
    };
  }

  // Task-specific assessment
  const taskSpecific: Record<string, { valid: boolean; description: string }> = {};

  if (criteria.taskSpecific.specificReferences) {
    const hasFileRefs = todos.some(t =>
      /\.(ts|js|py|md|json|yml|yaml|txt)|src\/|\/.*\/|[A-Z][a-zA-Z]*\./.test(t.content)
    );
    taskSpecific.specificReferences = {
      valid: hasFileRefs,
      description: 'Steps should reference specific files, functions, or components'
    };
  }

  if (criteria.taskSpecific.actionVerbs) {
    const actionVerbs = ['read', 'write', 'create', 'update', 'delete', 'fix', 'implement', 'test', 'run', 'build'];
    const hasActionVerbs = todos.some(t =>
      actionVerbs.some(verb => t.content.toLowerCase().startsWith(verb))
    );
    taskSpecific.actionVerbs = {
      valid: hasActionVerbs,
      description: 'Steps should start with action verbs'
    };
  }

  if (criteria.taskSpecific.completionCriteria) {
    const hasCriteria = todos.some(t =>
      t.content.length > 20 && // Reasonable detail
      !t.content.toLowerCase().includes('handle') && // Avoid vague language
      !t.content.toLowerCase().includes('deal with')
    );
    taskSpecific.completionCriteria = {
      valid: hasCriteria,
      description: 'Steps should have clear, specific completion criteria'
    };
  }

  return {
    stepCount,
    qualityScore,
    patterns,
    taskSpecific
  };
}

/**
 * Calculate confidence in plan quality
 */
function calculateConfidence(
  baseValidation: TodoListValidationResult,
  criteriaAssessment: any
): number {
  let confidence = baseValidation.overallQuality;

  // Boost confidence for meeting criteria
  if (criteriaAssessment.stepCount.valid) confidence += 5;
  if (criteriaAssessment.qualityScore.valid) confidence += 10;

  // Boost for patterns
  const patternScore = Object.values(criteriaAssessment.patterns).filter((p: any) => p.found).length;
  const totalPatterns = Object.keys(criteriaAssessment.patterns).length;
  if (totalPatterns > 0) {
    confidence += (patternScore / totalPatterns) * 15;
  }

  // Boost for task-specific criteria
  const taskScore = Object.values(criteriaAssessment.taskSpecific).filter((t: any) => t.valid).length;
  const totalTaskCriteria = Object.keys(criteriaAssessment.taskSpecific).length;
  if (totalTaskCriteria > 0) {
    confidence += (taskScore / totalTaskCriteria) * 10;
  }

  return Math.min(100, Math.max(0, Math.round(confidence)));
}

/**
 * Generate specific improvements based on validation results
 */
function generateImprovements(
  baseValidation: TodoListValidationResult,
  criteriaAssessment: any,
  criteria: PlanValidationCriteria
): string[] {
  const improvements: string[] = [];

  // Step count improvements
  if (!criteriaAssessment.stepCount.valid) {
    if (criteriaAssessment.stepCount.actual < criteria.minSteps) {
      improvements.push(`Add more steps (need ${criteria.minSteps - criteriaAssessment.stepCount.actual} more)`);
    } else {
      improvements.push(`Reduce steps to ${criteria.maxSteps} or fewer - consider breaking into multiple tasks`);
    }
  }

  // Quality improvements
  if (!criteriaAssessment.qualityScore.valid) {
    improvements.push('Improve step specificity and clarity - avoid vague language');
  }

  // Pattern improvements
  Object.entries(criteriaAssessment.patterns).forEach(([, result]: [string, any]) => {
    if (!result.found) {
      improvements.push(result.description);
    }
  });

  // Task-specific improvements
  Object.entries(criteriaAssessment.taskSpecific).forEach(([, result]: [string, any]) => {
    if (!result.valid) {
      improvements.push(result.description);
    }
  });

  // Add base validation suggestions
  improvements.push(...baseValidation.suggestions.slice(0, 3));

  // Remove duplicates and limit to top recommendations
  return [...new Set(improvements)].slice(0, 8);
}

/**
 * Quick plan quality check
 */
export function quickPlanCheck(todos: Todo[]): {
  isGood: boolean;
  score: number;
  topIssue?: string;
} {
  if (todos.length === 0) {
    return { isGood: false, score: 0, topIssue: 'No todos provided' };
  }

  const validation = validatePlan(todos);

  return {
    isGood: validation.confidence >= 70,
    score: validation.confidence,
    topIssue: validation.improvements[0]
  };
}

/**
 * Get recommended criteria for task type
 */
export function getRecommendedCriteria(planType: 'feature' | 'bugfix' | 'analysis'): PlanValidationCriteria {
  return { ...DEFAULT_CRITERIA[planType] };
}
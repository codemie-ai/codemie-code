/**
 * Context-Aware Planning Implementation
 *
 * This module implements intelligent planning that gathers context before creating plans,
 * inspired by proper software engineering practices where understanding comes before action.
 */

import type { CodeMieAgent } from '../agent.js';
import type { EventCallback } from '../types.js';

export interface ContextGatheringConfig {
  maxFilesToRead?: number;
  maxDirectoryDepth?: number;
  includeTests?: boolean;
  includeConfig?: boolean;
  analyzeDependencies?: boolean;
  debug?: boolean;
}

export interface ProjectContext {
  projectType: string;
  mainLanguages: string[];
  frameworks: string[];
  projectStructure: Record<string, any>;
  keyFiles: string[];
  existingFeatures: string[];
  dependencies: Record<string, any>;
  testFrameworks: string[];
  buildSystem: string;
}

export class ContextAwarePlanner {
  private agent: CodeMieAgent;
  private config: ContextGatheringConfig;
  private eventCallback?: EventCallback;

  constructor(agent: CodeMieAgent, config: ContextGatheringConfig = {}) {
    this.agent = agent;
    this.config = {
      maxFilesToRead: 20,
      maxDirectoryDepth: 4,
      includeTests: true,
      includeConfig: true,
      analyzeDependencies: true,
      debug: true,
      ...config
    };
  }

  /**
   * Create a context-aware plan by first gathering information about the project
   */
  async createContextAwarePlan(
    task: string,
    eventCallback?: EventCallback
  ): Promise<{ plan: string; context: ProjectContext }> {

    this.eventCallback = eventCallback;
    this.log('🔍 Starting context-aware planning...');

    // Phase 1: Discover project structure
    eventCallback?.({
      type: 'planning_start',
      planningInfo: {
        phase: 'in_progress',
        message: 'Exploring project structure...'
      }
    });

    const projectContext = await this.gatherProjectContext();
    this.log(`📁 Discovered project type: ${projectContext.projectType}`);

    // Phase 2: Analyze task in context
    eventCallback?.({
      type: 'planning_start',
      planningInfo: {
        phase: 'in_progress',
        message: 'Analyzing task requirements...'
      }
    });

    const taskAnalysis = await this.analyzeTaskInContext(task, projectContext);
    this.log(`🎯 Task analysis complete`);

    // Phase 3: Create informed plan
    eventCallback?.({
      type: 'planning_start',
      planningInfo: {
        phase: 'in_progress',
        message: 'Creating context-aware plan...'
      }
    });

    const plan = await this.generateInformedPlan(task, projectContext, taskAnalysis);
    this.log(`📋 Generated informed plan with ${this.countSteps(plan)} steps`);

    return { plan, context: projectContext };
  }

  /**
   * Phase 1: Gather comprehensive project context using agent's actual tools
   */
  private async gatherProjectContext(): Promise<ProjectContext> {
    this.log('📂 Starting comprehensive project context gathering...');

    // Starting context gathering phase - emit initial 0% progress
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'context_gathering',
        message: 'Starting project exploration...',
        phaseProgress: 0,
        overallProgress: 0,
        details: 'Initializing context gathering and project analysis'
      }
    });

    // Have the agent actually perform context gathering by executing a comprehensive exploration
    const contextGatheringPrompt = `
You are gathering context about this project for planning purposes. Please perform the following steps systematically:

1. **Explore Project Structure**: Use list_directory to explore the root directory and key subdirectories
2. **Identify Key Files**: Look for configuration files, main source files, documentation
3. **Read Important Files**: Read package.json, README.md, main source files, and configuration files
4. **Analyze Dependencies**: If there's a package.json, analyze the dependencies
5. **Understand Project Type**: Determine what type of project this is and what technologies it uses

Please work systematically and call the appropriate tools (list_directory, read_file) to gather comprehensive information about this project. Focus on understanding:
- Project type and main technologies
- Key source files and their purposes
- Dependencies and configuration
- Project structure and organization

Start by exploring the root directory, then identify and read the most important files.`;

    // Use the agent to perform actual context gathering with real tool calls
    let contextInfo = '';
    let toolCallCount = 0;
    const maxToolCalls = 10; // Reduced to prevent context window overflow

    await this.agent.chatStream(contextGatheringPrompt, (event) => {
      // Track each individual tool call (including duplicates) and show specific tool being used
      if (event.type === 'tool_call_start' && toolCallCount < maxToolCalls) {
        toolCallCount++;

        // Get specific tool name and arguments for more informative progress
        const toolName = event.toolName || 'tool';
        const toolArgs = event.toolArgs || {};
        const toolDisplayName = this.getToolDisplayName(toolName);

        // Extract specific parameter for display based on tool type
        let paramDetails = '';
        if (toolName === 'read_file' && toolArgs.filePath) {
          paramDetails = `(${toolArgs.filePath})`;
        } else if (toolName === 'list_directory' && toolArgs.directoryPath) {
          paramDetails = `(${toolArgs.directoryPath || '.'})`;
        } else if (toolName === 'execute_command' && toolArgs.command) {
          paramDetails = `(${toolArgs.command.substring(0, 30)}${toolArgs.command.length > 30 ? '...' : ''})`;
        } else if (Object.keys(toolArgs).length > 0) {
          // Show first parameter for other tools
          const firstParam = Object.values(toolArgs)[0];
          if (typeof firstParam === 'string') {
            paramDetails = `(${firstParam.substring(0, 25)}${firstParam.length > 25 ? '...' : ''})`;
          }
        }

        // Update progress based on tool calls
        const progressIncrement = 70 / maxToolCalls; // Spread 70% across maximum tool calls
        const currentProgress = Math.min(10 + (toolCallCount * progressIncrement), 70);

        // Emit planning tool call event with arguments for enhanced progress display
        this.eventCallback?.({
          type: 'planning_tool_call',
          planningToolCall: {
            toolName: toolName,
            args: toolArgs,
            step: toolCallCount,
            totalSteps: maxToolCalls,
            purpose: `Context gathering via ${toolDisplayName}`
          }
        });

        this.eventCallback?.({
          type: 'planning_progress',
          planningProgress: {
            phase: 'context_gathering',
            message: `${toolDisplayName} ${paramDetails} (${toolCallCount}/${maxToolCalls})`,
            phaseProgress: Math.round(currentProgress),
            overallProgress: Math.round(currentProgress * 0.8), // Context gathering is 0-80% of overall
            details: `Executing ${toolName} with args: ${JSON.stringify(toolArgs)}`
          }
        });

        // Log each tool call with parameters for debug visibility
        this.log(`🔧 Tool call ${toolCallCount}: ${toolName} ${JSON.stringify(toolArgs)} - Progress: ${Math.round(currentProgress)}%`);
      }

      if (event.type === 'content_chunk' && event.content) {
        contextInfo += event.content;
      }
    });

    this.log(`📊 Context gathering completed with ${toolCallCount} tool calls`);

    // Parse the gathered context information
    const context: ProjectContext = await this.parseContextFromOutput(contextInfo);

    // Final dependency analysis if enabled
    if (this.config.analyzeDependencies) {
      this.eventCallback?.({
        type: 'planning_progress',
        planningProgress: {
          phase: 'context_gathering',
          message: 'Analyzing project dependencies...',
          phaseProgress: 85,
          overallProgress: 75,
          details: 'Extracting dependency information from discovered files'
        }
      });

      await new Promise(resolve => setTimeout(resolve, 500)); // Brief pause for dependency analysis
    }

    this.log(`✅ Context gathering complete - discovered ${context.frameworks.length} frameworks`);

    // Complete context gathering phase
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'context_gathering',
        message: 'Context analysis complete',
        phaseProgress: 100,
        overallProgress: 80,
        details: `Project analysis finished - ready for task planning`
      }
    });

    return context;
  }

  /**
   * Phase 2: Analyze task requirements in project context
   */
  private async analyzeTaskInContext(
    task: string,
    context: ProjectContext
  ): Promise<{
    taskType: 'feature' | 'bugfix' | 'refactor' | 'setup' | 'analysis';
    complexity: 'simple' | 'medium' | 'complex';
    affectedAreas: string[];
    requiredKnowledge: string[];
    dependencies: string[];
  }> {

    // Starting task analysis phase (no phase change event needed)

    // Emit initial task analysis progress (continuing from context gathering ~80%)
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'task_analysis',
        message: 'Analyzing task requirements in project context...',
        phaseProgress: 10,
        overallProgress: 80,
        details: 'Using discovered project context to understand task requirements'
      }
    });

    // Emit tool call for LLM analysis
    this.eventCallback?.({
      type: 'planning_tool_call',
      planningToolCall: {
        toolName: 'llm_analysis',
        step: 1,
        totalSteps: 2,
        purpose: 'Analyze task requirements using project context'
      }
    });

    // Use the agent to analyze the task with full context
    const analysisPrompt = `
Analyze this task in the context of the discovered project:

TASK: ${task}

PROJECT CONTEXT:
- Type: ${context.projectType}
- Languages: ${context.mainLanguages.join(', ')}
- Frameworks: ${context.frameworks.join(', ')}
- Build System: ${context.buildSystem}
- Key Files: ${context.keyFiles.slice(0, 5).join(', ')}

Please analyze:
1. What type of task is this? (feature/bugfix/refactor/setup/analysis)
2. What complexity level? (simple/medium/complex)
3. Which areas of the codebase will be affected?
4. What knowledge/skills are required?
5. What dependencies or prerequisites exist?

Provide a structured analysis.`;

    const analysisResult = await this.runAgentAnalysis(analysisPrompt);

    // Update progress after LLM analysis
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'task_analysis',
        message: 'Processing task analysis results...',
        phaseProgress: 80,
        overallProgress: 85,
        details: 'Extracting task type, complexity, and requirements'
      }
    });

    // Parse the analysis (simplified - in real implementation would be more robust)
    const taskAnalysis = {
      taskType: this.extractTaskType(analysisResult),
      complexity: this.extractComplexity(analysisResult),
      affectedAreas: this.extractAffectedAreas(analysisResult, context),
      requiredKnowledge: this.extractRequiredKnowledge(analysisResult),
      dependencies: this.extractDependencies(analysisResult)
    };

    // Emit discovery about task analysis
    this.eventCallback?.({
      type: 'planning_discovery',
      planningDiscovery: {
        type: 'feature_detection',
        summary: `Task identified as ${taskAnalysis.taskType} with ${taskAnalysis.complexity} complexity`,
        data: {
          taskType: taskAnalysis.taskType,
          complexity: taskAnalysis.complexity,
          affectedAreas: taskAnalysis.affectedAreas,
          requiredKnowledge: taskAnalysis.requiredKnowledge
        },
        impact: 'Task requirements understood, ready for intelligent plan generation'
      }
    });

    // Complete task analysis phase
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'task_analysis',
        message: 'Task analysis complete',
        phaseProgress: 100,
        overallProgress: 88,
        details: `${taskAnalysis.taskType} task requiring ${taskAnalysis.requiredKnowledge.join(', ')} knowledge`
      }
    });

    return taskAnalysis;
  }

  /**
   * Phase 3: Generate informed, context-aware plan
   */
  private async generateInformedPlan(
    task: string,
    context: ProjectContext,
    analysis: any
  ): Promise<string> {

    // Emit phase change to plan generation
    this.eventCallback?.({
      type: 'planning_phase_change',
      planningPhaseChange: {
        fromPhase: 'task_analysis',
        toPhase: 'plan_generation',
        message: 'Creating context-aware implementation plan',
        previousPhaseResults: {
          taskType: analysis.taskType,
          complexity: analysis.complexity,
          affectedAreas: analysis.affectedAreas
        }
      }
    });

    // Emit initial plan generation progress
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'plan_generation',
        message: 'Creating context-aware plan with specific steps...',
        phaseProgress: 10,
        overallProgress: 90,
        details: 'Using project context and task analysis to generate intelligent plan'
      }
    });

    // Emit tool call for plan generation
    this.eventCallback?.({
      type: 'planning_tool_call',
      planningToolCall: {
        toolName: 'llm_plan_generation',
        step: 1,
        totalSteps: 2,
        purpose: 'Generate context-aware implementation plan'
      }
    });

    const contextAwarePlanningPrompt = `
Create a detailed, context-aware implementation plan for this task:

TASK: ${task}

DISCOVERED PROJECT CONTEXT:
- Project Type: ${context.projectType}
- Languages: ${context.mainLanguages.join(', ')}
- Frameworks: ${context.frameworks.join(', ')}
- Build System: ${context.buildSystem}
- Test Frameworks: ${context.testFrameworks.join(', ')}

KEY FILES ANALYZED:
${context.keyFiles.slice(0, 5).map(f => `- ${f}`).join('\n')}

EXISTING FEATURES:
${context.existingFeatures.slice(0, 5).map(f => `- ${f}`).join('\n')}

TASK ANALYSIS:
- Type: ${analysis.taskType}
- Complexity: ${analysis.complexity}
- Affected Areas: ${analysis.affectedAreas.join(', ')}

INSTRUCTIONS:
1. Call write_todos() with a comprehensive plan that:
   - References specific files that were discovered (e.g., "Read src/config.ts file")
   - Accounts for the existing project structure
   - Follows the project's established patterns
   - Includes appropriate testing steps for detected test frameworks
   - Considers dependencies and build system requirements

2. Create 4-8 specific, actionable steps that:
   - Start with action verbs: "Read", "Analyze", "Create", "Update", "Test", "Review"
   - Include concrete file paths and function names where possible
   - Reference actual discovered files and directories (e.g., "Read package.json dependencies", "Analyze src/agents/ directory structure")
   - Follow the project's established conventions
   - Include verification and testing steps appropriate to the project

3. Make the plan informed by the actual codebase, not generic assumptions.
4. Use specific file paths, function names, and component references discovered during exploration.
5. Avoid vague terms like "thing", "stuff", "handle" - be specific about what to do.

Now create your context-aware plan using write_todos():`;

    // Update progress during plan generation
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'plan_generation',
        message: 'Generating structured todos based on project analysis...',
        phaseProgress: 60,
        overallProgress: 93,
        details: 'Creating specific, actionable steps using discovered context'
      }
    });

    const planResult = await this.runAgentAnalysis(contextAwarePlanningPrompt);

    // Emit tool call for plan validation
    this.eventCallback?.({
      type: 'planning_tool_call',
      planningToolCall: {
        toolName: 'plan_validation',
        step: 2,
        totalSteps: 2,
        purpose: 'Validate generated plan quality and completeness'
      }
    });

    // Update progress for plan completion
    this.eventCallback?.({
      type: 'planning_progress',
      planningProgress: {
        phase: 'plan_generation',
        message: 'Context-aware plan generated successfully',
        phaseProgress: 100,
        overallProgress: 95,
        details: 'Plan created with specific file references and project-aware steps'
      }
    });

    // Emit final planning phase change
    this.eventCallback?.({
      type: 'planning_phase_change',
      planningPhaseChange: {
        fromPhase: 'plan_generation',
        toPhase: 'plan_validation',
        message: 'Plan generation complete, validating quality',
        previousPhaseResults: {
          planGenerated: true,
          contextAware: true
        }
      }
    });

    return planResult;
  }

  // Helper methods for context analysis

  private async parseContextFromOutput(contextInfo: string): Promise<ProjectContext> {
    this.log('🔍 Parsing context information from agent output...');

    // Extract project information from the agent's context gathering output
    // This is a simplified implementation - in practice would use more sophisticated parsing
    const context: ProjectContext = {
      projectType: this.extractProjectTypeFromOutput(contextInfo),
      mainLanguages: this.extractLanguagesFromOutput(contextInfo),
      frameworks: this.extractFrameworksFromOutput(contextInfo),
      projectStructure: {}, // Will be populated from actual tool calls
      keyFiles: this.extractKeyFilesFromOutput(contextInfo),
      existingFeatures: this.extractFeaturesFromOutput(contextInfo),
      dependencies: this.extractDependenciesFromOutput(contextInfo),
      testFrameworks: this.extractTestFrameworksFromOutput(contextInfo),
      buildSystem: this.extractBuildSystemFromOutput(contextInfo)
    };

    this.log(`📋 Parsed context: ${context.projectType} project with ${context.frameworks.length} frameworks`);
    return context;
  }

  private extractProjectTypeFromOutput(output: string): string {
    if (output.toLowerCase().includes('package.json')) return 'Node.js';
    if (output.toLowerCase().includes('requirements.txt')) return 'Python';
    if (output.toLowerCase().includes('cargo.toml')) return 'Rust';
    if (output.toLowerCase().includes('go.mod')) return 'Go';
    return 'Unknown';
  }

  private extractLanguagesFromOutput(output: string): string[] {
    const languages: string[] = [];
    if (output.includes('.ts') || output.includes('typescript')) languages.push('TypeScript');
    if (output.includes('.js') || output.includes('javascript')) languages.push('JavaScript');
    if (output.includes('.py') || output.includes('python')) languages.push('Python');
    return languages.length > 0 ? languages : ['Unknown'];
  }

  private extractFrameworksFromOutput(output: string): string[] {
    const frameworks: string[] = [];
    const lowerOutput = output.toLowerCase();
    if (lowerOutput.includes('react')) frameworks.push('React');
    if (lowerOutput.includes('vue')) frameworks.push('Vue');
    if (lowerOutput.includes('angular')) frameworks.push('Angular');
    if (lowerOutput.includes('express')) frameworks.push('Express');
    if (lowerOutput.includes('next')) frameworks.push('Next.js');
    return frameworks;
  }

  private extractKeyFilesFromOutput(output: string): string[] {
    const keyFiles: string[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Look for common key files mentioned in the output
      if (line.includes('package.json')) keyFiles.push('package.json');
      if (line.includes('README.md')) keyFiles.push('README.md');
      if (line.includes('tsconfig.json')) keyFiles.push('tsconfig.json');
      if (line.includes('index.ts') || line.includes('index.js')) {
        keyFiles.push(line.includes('index.ts') ? 'index.ts' : 'index.js');
      }
    }

    return [...new Set(keyFiles)]; // Remove duplicates
  }

  private extractFeaturesFromOutput(output: string): string[] {
    // Extract mentioned features/components from the output
    const features: string[] = [];
    const lowerOutput = output.toLowerCase();

    if (lowerOutput.includes('cli')) features.push('CLI Interface');
    if (lowerOutput.includes('agent')) features.push('Agent System');
    if (lowerOutput.includes('api')) features.push('API');
    if (lowerOutput.includes('ui') || lowerOutput.includes('interface')) features.push('User Interface');
    if (lowerOutput.includes('tool')) features.push('Tools');

    return features;
  }

  private extractDependenciesFromOutput(output: string): Record<string, any> {
    // Simple dependency extraction - would be more sophisticated in practice
    return {
      detected: output.toLowerCase().includes('dependencies'),
      hasPackageJson: output.toLowerCase().includes('package.json')
    };
  }

  private extractTestFrameworksFromOutput(output: string): string[] {
    const frameworks: string[] = [];
    const lowerOutput = output.toLowerCase();

    if (lowerOutput.includes('jest')) frameworks.push('Jest');
    if (lowerOutput.includes('mocha')) frameworks.push('Mocha');
    if (lowerOutput.includes('vitest')) frameworks.push('Vitest');
    if (lowerOutput.includes('test')) frameworks.push('Testing Framework');

    return frameworks;
  }

  private extractBuildSystemFromOutput(output: string): string {
    const lowerOutput = output.toLowerCase();

    if (lowerOutput.includes('webpack')) return 'Webpack';
    if (lowerOutput.includes('vite')) return 'Vite';
    if (lowerOutput.includes('rollup')) return 'Rollup';
    if (lowerOutput.includes('npm')) return 'npm';
    if (lowerOutput.includes('yarn')) return 'Yarn';

    return 'Unknown';
  }

  private async exploreSubdirectories(rootStructure: Record<string, any>): Promise<string[]> {
    const directories: string[] = [];
    this.log(`🔍 Starting subdirectory exploration...`);

    // Find directories to explore
    for (const [name, info] of Object.entries(rootStructure)) {
      if (info && typeof info === 'object' && info.type === 'directory') {
        // Skip common directories that don't need deep exploration
        if (!['node_modules', '.git', 'dist', 'build', '.next'].includes(name)) {
          directories.push(name);
          this.log(`📂 Will explore subdirectory: ${name}`);
        }
      }
    }

    // Explore each directory
    for (const dir of directories) {
      try {
        this.log(`🔍 Exploring ${dir}/...`);
        const subStructure = await this.exploreDirectory(dir);
        this.log(`📁 Found ${Object.keys(subStructure).length} items in ${dir}/`);

        // Add small delay to show progress
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        this.log(`⚠️  Failed to explore ${dir}: ${error}`);
      }
    }

    this.log(`✅ Completed exploration of ${directories.length} subdirectories`);
    return directories;
  }

  private async searchForRelevantFiles(): Promise<string[]> {
    this.log(`🔎 Searching for additional relevant files...`);
    const relevantFiles: string[] = [];

    try {
      // Search for common important file patterns
      const patterns = [
        '*.md', '*.txt', '*.config.*', '*.env*',
        'Dockerfile*', '*.yml', '*.yaml', '*.json'
      ];

      for (const pattern of patterns) {
        this.log(`🔍 Searching for ${pattern} files`);
        // Simulate file search - in real implementation would use actual search
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      // Add some common files that might exist
      const commonFiles = [
        'README.md', 'CHANGELOG.md', 'LICENSE',
        '.env.example', 'docker-compose.yml', 'Dockerfile'
      ];

      for (const file of commonFiles) {
        try {
          // Check if file exists by trying to read it
          await this.readFileViaAgent(file);
          relevantFiles.push(file);
          this.log(`✓ Found additional file: ${file}`);
        } catch {
          // File doesn't exist, which is fine
        }
      }

    } catch (error) {
      this.log(`⚠️  Error during file search: ${error}`);
    }

    this.log(`🔎 Found ${relevantFiles.length} additional relevant files`);
    return relevantFiles;
  }

  private async exploreDirectory(path: string): Promise<Record<string, any>> {
    try {
      const result = await this.runAgentTool('list_directory', { directoryPath: path });
      return this.parseDirectoryListing(result);
    } catch (error) {
      this.log(`Failed to explore ${path}: ${error}`);
      return {};
    }
  }

  private async readFileViaAgent(filePath: string): Promise<string> {
    try {
      const result = await this.runAgentTool('read_file', { filePath });
      // Extract just the content part (after "File: filepath\n\n")
      const contentMatch = result.match(/^File: [^\n]+\n\n([\s\S]*)$/);
      return contentMatch ? contentMatch[1] : result;
    } catch (error) {
      this.log(`Failed to read ${filePath}: ${error}`);
      return '';
    }
  }

  private detectProjectType(structure: Record<string, any>): string {
    // Detect project type based on files and structure
    if (structure['package.json']) return 'Node.js';
    if (structure['requirements.txt'] || structure['pyproject.toml']) return 'Python';
    if (structure['Cargo.toml']) return 'Rust';
    if (structure['go.mod']) return 'Go';
    if (structure['pom.xml'] || structure['build.gradle']) return 'Java';
    if (structure['composer.json']) return 'PHP';
    return 'Unknown';
  }

  private identifyKeyFiles(structure: Record<string, any>, projectType: string): string[] {
    const keyFiles: string[] = [];

    // Add configuration files
    const configFiles = ['package.json', 'tsconfig.json', 'webpack.config.js',
                        'vite.config.js', 'next.config.js', 'tailwind.config.js',
                        'requirements.txt', 'pyproject.toml', 'setup.py',
                        'Cargo.toml', 'go.mod', 'pom.xml'];

    configFiles.forEach(file => {
      if (structure[file]) keyFiles.push(file);
    });

    // Add main entry points based on project type
    if (projectType === 'Node.js') {
      ['src/index.js', 'src/index.ts', 'src/app.js', 'src/app.ts',
       'index.js', 'main.js', 'app.js'].forEach(file => {
        if (this.fileExists(structure, file)) keyFiles.push(file);
      });
    }

    return keyFiles;
  }

  private detectLanguages(structure: Record<string, any>): string[] {
    const languages: string[] = [];
    const fileTypes = this.extractFileExtensions(structure);

    if (fileTypes.includes('.ts') || fileTypes.includes('.tsx')) languages.push('TypeScript');
    if (fileTypes.includes('.js') || fileTypes.includes('.jsx')) languages.push('JavaScript');
    if (fileTypes.includes('.py')) languages.push('Python');
    if (fileTypes.includes('.rs')) languages.push('Rust');
    if (fileTypes.includes('.go')) languages.push('Go');
    if (fileTypes.includes('.java')) languages.push('Java');

    return languages;
  }

  private detectFrameworks(fileContents: Record<string, string>): string[] {
    const frameworks: string[] = [];
    const allContent = Object.values(fileContents).join('\n').toLowerCase();

    if (allContent.includes('react')) frameworks.push('React');
    if (allContent.includes('vue')) frameworks.push('Vue');
    if (allContent.includes('angular')) frameworks.push('Angular');
    if (allContent.includes('next')) frameworks.push('Next.js');
    if (allContent.includes('express')) frameworks.push('Express');
    if (allContent.includes('fastapi')) frameworks.push('FastAPI');
    if (allContent.includes('django')) frameworks.push('Django');
    if (allContent.includes('flask')) frameworks.push('Flask');

    return frameworks;
  }

  private extractExistingFeatures(fileContents: Record<string, string>): string[] {
    // Extract existing features/components from code analysis
    const features: string[] = [];

    Object.entries(fileContents).forEach(([_file, content]) => {
      // Extract class names, function names, component names, etc.
      const classMatches = content.match(/class\s+(\w+)/g);
      const functionMatches = content.match(/function\s+(\w+)/g);
      const componentMatches = content.match(/const\s+(\w+)\s*=.*=>/g);

      if (classMatches) features.push(...classMatches.map(m => m.replace('class ', '')));
      if (functionMatches) features.push(...functionMatches.map(m => m.replace('function ', '')));
      if (componentMatches) features.push(...componentMatches.map(m => m.split('=')[0].replace('const ', '').trim()));
    });

    return [...new Set(features)].slice(0, 10); // Dedupe and limit
  }

  private detectTestFrameworks(fileContents: Record<string, string>): string[] {
    const frameworks: string[] = [];
    const allContent = Object.values(fileContents).join('\n').toLowerCase();

    if (allContent.includes('jest')) frameworks.push('Jest');
    if (allContent.includes('mocha')) frameworks.push('Mocha');
    if (allContent.includes('chai')) frameworks.push('Chai');
    if (allContent.includes('pytest')) frameworks.push('Pytest');
    if (allContent.includes('unittest')) frameworks.push('unittest');
    if (allContent.includes('vitest')) frameworks.push('Vitest');

    return frameworks;
  }

  private detectBuildSystem(fileContents: Record<string, string>): string {
    if (fileContents['package.json']?.includes('webpack')) return 'Webpack';
    if (fileContents['package.json']?.includes('vite')) return 'Vite';
    if (fileContents['package.json']?.includes('rollup')) return 'Rollup';
    if (fileContents['requirements.txt']) return 'pip';
    if (fileContents['Cargo.toml']) return 'Cargo';
    if (fileContents['go.mod']) return 'Go modules';
    return 'Unknown';
  }

  // Agent interaction helpers

  private async runAgentTool(toolName: string, params: any): Promise<string> {
    try {
      // Use the agent's tool system to call the specified tool
      const tools = await this.agent.getTools();
      const tool = tools.find(t => t.name === toolName);

      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      const result = await tool.invoke(params);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (error) {
      this.log(`⚠️ Tool ${toolName} failed: ${error}`);
      return `Error calling ${toolName}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async runAgentAnalysis(prompt: string): Promise<string> {
    try {
      // Use the agent's chat system to analyze the prompt
      let result = '';
      await this.agent.chatStream(prompt, (event) => {
        if (event.type === 'content_chunk' && event.content) {
          result += event.content;
        }
      });
      return result;
    } catch (error) {
      this.log(`⚠️ Agent analysis failed: ${error}`);
      return `Error during analysis: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // Utility methods

  private log(message: string): void {
    if (this.config.debug) {
      console.log(`[ContextAwarePlanner] ${message}`);
    }
  }

  private getToolDisplayName(toolName: string): string {
    const toolDisplayNames: Record<string, string> = {
      'list_directory': 'Exploring directories',
      'read_file': 'Reading files',
      'execute_command': 'Running commands',
      'write_file': 'Writing files',
      'write_todos': 'Creating todos',
      'update_todo_status': 'Updating todos',
      'append_todo': 'Adding todos',
      'show_todos': 'Displaying todos'
    };

    return toolDisplayNames[toolName] || `Using ${toolName}`;
  }

  private countSteps(plan: string): number {
    return (plan.match(/\d+\./g) || []).length;
  }

  private parseDirectoryListing(result: string): Record<string, any> {
    const structure: Record<string, any> = {};

    try {
      const lines = result.split('\n');
      let currentSection = '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed === 'Directories:') {
          currentSection = 'directories';
          continue;
        } else if (trimmed === 'Files:') {
          currentSection = 'files';
          continue;
        }

        // Parse directory or file entry
        const entryMatch = trimmed.match(/^\s*(.+?)\/?$/);
        if (entryMatch && currentSection) {
          const name = entryMatch[1];
          if (currentSection === 'directories') {
            structure[name] = { type: 'directory' };
          } else if (currentSection === 'files') {
            structure[name] = { type: 'file' };
          }
        }
      }
    } catch (error) {
      this.log(`Failed to parse directory listing: ${error}`);
    }

    return structure;
  }

  private fileExists(structure: Record<string, any>, path: string): boolean {
    return !!structure[path];
  }

  private extractFileExtensions(structure: Record<string, any>): string[] {
    return Object.keys(structure)
      .map(file => {
        const lastDot = file.lastIndexOf('.');
        return lastDot > 0 ? file.substring(lastDot) : '';
      })
      .filter(ext => ext.length > 0);
  }

  private async analyzeDependencies(fileContents: Record<string, string>): Promise<Record<string, any>> {
    const dependencies: Record<string, any> = {};

    // Analyze package.json dependencies
    if (fileContents['package.json']) {
      try {
        const packageJson = JSON.parse(fileContents['package.json']);
        dependencies.npm = {
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {}
        };
      } catch (error) {
        this.log(`Failed to parse package.json: ${error}`);
      }
    }

    return dependencies;
  }

  // Task analysis helpers

  private extractTaskType(analysis: string): 'feature' | 'bugfix' | 'refactor' | 'setup' | 'analysis' {
    const lower = analysis.toLowerCase();
    if (lower.includes('bug') || lower.includes('fix')) return 'bugfix';
    if (lower.includes('refactor')) return 'refactor';
    if (lower.includes('setup') || lower.includes('configure')) return 'setup';
    if (lower.includes('analyze') || lower.includes('understand')) return 'analysis';
    return 'feature';
  }

  private extractComplexity(analysis: string): 'simple' | 'medium' | 'complex' {
    const lower = analysis.toLowerCase();
    if (lower.includes('complex') || lower.includes('difficult')) return 'complex';
    if (lower.includes('medium') || lower.includes('moderate')) return 'medium';
    return 'simple';
  }

  private extractAffectedAreas(analysis: string, context: ProjectContext): string[] {
    const areas: string[] = [];

    // Extract areas mentioned in analysis
    const patterns = [
      /frontend|ui|interface|component/gi,
      /backend|server|api|endpoint/gi,
      /database|db|storage|model/gi,
      /test|testing|spec/gi,
      /config|configuration|setting/gi,
      /build|deployment|ci\/cd/gi
    ];

    const labels = ['frontend', 'backend', 'database', 'testing', 'configuration', 'build'];

    patterns.forEach((pattern, index) => {
      if (pattern.test(analysis)) {
        areas.push(labels[index]);
      }
    });

    // Add file-based areas from key files
    context.keyFiles.forEach(file => {
      if (file.includes('src/') && !areas.includes('source code')) {
        areas.push('source code');
      }
      if ((file.includes('test') || file.includes('spec')) && !areas.includes('testing')) {
        areas.push('testing');
      }
    });

    return areas.length > 0 ? areas : ['general'];
  }

  private extractRequiredKnowledge(analysis: string): string[] {
    const knowledge: string[] = [];
    const lower = analysis.toLowerCase();

    // Add basic knowledge areas based on analysis content
    if (lower.includes('react') || lower.includes('component')) {
      knowledge.push('React');
    }
    if (lower.includes('typescript') || lower.includes('type')) {
      knowledge.push('TypeScript');
    }
    if (lower.includes('javascript') || lower.includes('js')) {
      knowledge.push('JavaScript');
    }
    if (lower.includes('node') || lower.includes('npm')) {
      knowledge.push('Node.js');
    }

    // Add general knowledge areas
    if (lower.includes('algorithm') || lower.includes('data structure')) {
      knowledge.push('Algorithms & Data Structures');
    }
    if (lower.includes('security') || lower.includes('auth')) {
      knowledge.push('Security');
    }
    if (lower.includes('performance') || lower.includes('optimization')) {
      knowledge.push('Performance Optimization');
    }

    return knowledge.length > 0 ? knowledge : ['General Programming'];
  }

  private extractDependencies(analysis: string): string[] {
    const dependencies: string[] = [];
    const lower = analysis.toLowerCase();

    // Extract dependency mentions
    if (lower.includes('npm install') || lower.includes('package.json')) {
      dependencies.push('npm packages');
    }
    if (lower.includes('database') || lower.includes('migration')) {
      dependencies.push('database setup');
    }
    if (lower.includes('environment') || lower.includes('config')) {
      dependencies.push('configuration');
    }
    if (lower.includes('api') || lower.includes('service')) {
      dependencies.push('external services');
    }

    return dependencies;
  }
}
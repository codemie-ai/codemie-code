// Copyright 2026 EPAM Systems, Inc. (“EPAM”)
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const CONNECTED_MODE_PATH = path.resolve(REPOSITORY_ROOT, '.sonarlint/connectedMode.json');
const SONAR_PROPERTIES_PATH = path.resolve(REPOSITORY_ROOT, 'sonar-project.properties');
const SERVER_TIMEOUT_MS = 5000;
const PAGE_SIZE = 500;

function log(message) {
    process.stdout.write(`[sonar-local] ${message}\n`);
}

function logError(message) {
    process.stderr.write(`[sonar-local] ${message}\n`);
}

function readConnectedModeConfig() {
    if (!fs.existsSync(CONNECTED_MODE_PATH)) {
        throw new Error(`Missing SonarLint connected mode config: ${CONNECTED_MODE_PATH}`);
    }

    const rawContent = fs.readFileSync(CONNECTED_MODE_PATH, 'utf8');
    const parsedConfig = JSON.parse(rawContent);
    const sonarHostUrl = parsedConfig.sonarQubeUri;
    const sonarProjectKey = parsedConfig.projectKey;

    if (!sonarHostUrl || !sonarProjectKey) {
        throw new Error(
            `SonarLint connected mode config must define both "sonarQubeUri" and "projectKey": ${CONNECTED_MODE_PATH}`,
        );
    }

    return { sonarHostUrl, sonarProjectKey };
}

function readSonarProperties() {
    if (!fs.existsSync(SONAR_PROPERTIES_PATH)) {
        throw new Error(`Missing Sonar project configuration: ${SONAR_PROPERTIES_PATH}`);
    }

    const properties = {};
    const rawContent = fs.readFileSync(SONAR_PROPERTIES_PATH, 'utf8');

    for (const rawLine of rawContent.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }

        const separatorIndex = line.indexOf('=');
        if (separatorIndex === -1) {
            continue;
        }

        const key = line.slice(0, separatorIndex).trim();
        const value = line.slice(separatorIndex + 1).trim();
        properties[key] = value;
    }

    return properties;
}

function createRequestModule(targetUrl) {
    return targetUrl.protocol === 'https:' ? https : http;
}

function resolveBranchName() {
    const overrideBranchName = process.env.SONAR_BRANCH_NAME?.trim();
    if (overrideBranchName) {
        return overrideBranchName;
    }

    const gitEntryPath = path.resolve(REPOSITORY_ROOT, '.git');
    if (!fs.existsSync(gitEntryPath)) {
        throw new Error('Unable to locate .git metadata. Set SONAR_BRANCH_NAME explicitly and retry.');
    }

    let gitDirPath = gitEntryPath;
    const gitEntryStat = fs.statSync(gitEntryPath);
    if (gitEntryStat.isFile()) {
        const gitPointer = fs.readFileSync(gitEntryPath, 'utf8').trim();
        const gitDirPrefix = 'gitdir:';
        if (!gitPointer.startsWith(gitDirPrefix)) {
            throw new Error('Unable to resolve git metadata directory. Set SONAR_BRANCH_NAME explicitly and retry.');
        }

        gitDirPath = path.resolve(REPOSITORY_ROOT, gitPointer.slice(gitDirPrefix.length).trim());
    }

    const headPath = path.join(gitDirPath, 'HEAD');
    if (!fs.existsSync(headPath)) {
        throw new Error('Unable to locate git HEAD. Set SONAR_BRANCH_NAME explicitly and retry.');
    }

    const headContents = fs.readFileSync(headPath, 'utf8').trim();
    const refPrefix = 'ref: refs/heads/';
    if (!headContents.startsWith(refPrefix)) {
        throw new Error('Unable to determine the current git branch from HEAD. Set SONAR_BRANCH_NAME explicitly.');
    }

    return headContents.slice(refPrefix.length);
}

function runCommand(command, args, options = {}) {
    const { env = process.env, description = command } = options;

    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: REPOSITORY_ROOT,
            env,
            stdio: 'inherit',
            shell: process.platform === 'win32',
        });

        child.on('error', (error) => {
            reject(new Error(`Failed to start ${description}: ${error.message}`));
        });

        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`${description} exited with code ${code}`));
        });
    });
}

function resolveScannerCommand() {
    const scannerCommand = process.env.SONAR_SCANNER_PATH?.trim() || 'sonar-scanner';

    if (scannerCommand === 'sonar-scanner') {
        const pathEntries = (process.env.PATH || '').split(path.delimiter);
        const executableNames =
            process.platform === 'win32'
                ? ['sonar-scanner.cmd', 'sonar-scanner.bat', 'sonar-scanner.exe']
                : ['sonar-scanner'];

        const foundScanner = pathEntries.some((entry) =>
            executableNames.some((name) => fs.existsSync(path.join(entry, name))),
        );
        if (!foundScanner) {
            throw new Error(
                'sonar-scanner was not found. Install the official SonarScanner CLI or set SONAR_SCANNER_PATH.',
            );
        }
    } else if (!fs.existsSync(scannerCommand)) {
        throw new Error(`SONAR_SCANNER_PATH does not exist: ${scannerCommand}`);
    }

    return scannerCommand;
}

function sonarRequestJson(sonarHostUrl, sonarToken, endpoint, searchParams = {}) {
    return new Promise((resolve, reject) => {
        const requestUrl = new URL(endpoint, sonarHostUrl);
        for (const [key, value] of Object.entries(searchParams)) {
            if (value !== undefined && value !== null && value !== '') {
                requestUrl.searchParams.set(key, String(value));
            }
        }

        const request = createRequestModule(requestUrl).request(
            requestUrl,
            {
                method: 'GET',
                timeout: SERVER_TIMEOUT_MS,
                headers: {
                    Authorization: `Basic ${Buffer.from(`${sonarToken}:`).toString('base64')}`,
                    Accept: 'application/json',
                },
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const rawBody = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode && response.statusCode >= 400) {
                        reject(new Error(`Sonar API request failed (${response.statusCode}) for ${requestUrl.pathname}.`));
                        return;
                    }

                    try {
                        resolve(JSON.parse(rawBody));
                    } catch (error) {
                        reject(new Error(`Failed to parse Sonar API response for ${requestUrl.pathname}: ${error.message}`));
                    }
                });
            },
        );

        request.on('timeout', () => {
            request.destroy(new Error(`Timed out after ${SERVER_TIMEOUT_MS}ms`));
        });

        request.on('error', (error) => {
            reject(new Error(`Sonar API request failed for ${requestUrl.pathname}: ${error.message}`));
        });

        request.end();
    });
}

async function fetchPaginatedItems(fetchPage) {
    const items = [];
    let page = 1;
    let total = 0;
    let pageSize = 0;

    do {
        const response = await fetchPage(page);
        const responseItems = response.issues ?? response.hotspots ?? [];
        items.push(...responseItems);
        total = response.total ?? response.paging?.total ?? responseItems.length;
        pageSize = response.ps ?? response.paging?.pageSize ?? responseItems.length;
        page += 1;
    } while (items.length < total && pageSize > 0);

    return items;
}

function stripProjectKey(component, projectKey) {
    const componentPrefix = `${projectKey}:`;
    if (!component) {
        return '(unknown component)';
    }

    return component.startsWith(componentPrefix) ? component.slice(componentPrefix.length) : component;
}

function formatIssue(issue, projectKey) {
    const location = `${stripProjectKey(issue.component, projectKey)}:${issue.line ?? 1}`;
    return `- [${issue.severity}] [${issue.type}] ${location} ${issue.rule}: ${issue.message}`;
}

function formatHotspot(hotspot, projectKey) {
    const location = `${stripProjectKey(hotspot.component, projectKey)}:${hotspot.line ?? 1}`;
    return `- ${location} ${hotspot.ruleKey ?? hotspot.rule ?? 'unknown-rule'}: ${hotspot.message}`;
}

async function collectSonarDetails({ sonarHostUrl, sonarProjectKey, branchName, sonarToken }) {
    const qualityGate = await sonarRequestJson(sonarHostUrl, sonarToken, '/api/qualitygates/project_status', {
        projectKey: sonarProjectKey,
        branch: branchName,
    });

    const issues = await fetchPaginatedItems((page) =>
        sonarRequestJson(sonarHostUrl, sonarToken, '/api/issues/search', {
            componentKeys: sonarProjectKey,
            branch: branchName,
            resolved: 'false',
            p: page,
            ps: PAGE_SIZE,
            s: 'FILE_LINE',
            asc: 'true',
        }),
    );

    const hotspots = await fetchPaginatedItems((page) =>
        sonarRequestJson(sonarHostUrl, sonarToken, '/api/hotspots/search', {
            projectKey: sonarProjectKey,
            branch: branchName,
            status: 'TO_REVIEW',
            p: page,
            ps: PAGE_SIZE,
        }),
    );

    return { hotspots, issues, qualityGate };
}

function printSonarDetails(details, context) {
    const { hotspots, issues, qualityGate } = details;
    const { branchName, sonarProjectKey } = context;

    log(`Project: ${sonarProjectKey}`);
    log(`Branch: ${branchName}`);
    log(`Quality gate: ${qualityGate.projectStatus.status}`);

    const failedConditions = (qualityGate.projectStatus.conditions ?? []).filter(
        (condition) => condition.status === 'ERROR',
    );
    if (failedConditions.length > 0) {
        log('Failing gate conditions:');
        for (const condition of failedConditions) {
            log(
                `- ${condition.metricKey}: actual=${condition.actualValue ?? 'n/a'}, threshold=${condition.errorThreshold ?? 'n/a'}`,
            );
        }
    } else {
        log('Failing gate conditions: none');
    }

    log(`Blocking security hotspots: ${hotspots.length}`);
    for (const hotspot of hotspots) {
        log(formatHotspot(hotspot, sonarProjectKey));
    }

    const bugsAndVulnerabilities = issues.filter((issue) => issue.type === 'BUG' || issue.type === 'VULNERABILITY');
    log(`Bugs and vulnerabilities: ${bugsAndVulnerabilities.length}`);
    for (const issue of bugsAndVulnerabilities) {
        log(formatIssue(issue, sonarProjectKey));
    }

    log(`All unresolved issues: ${issues.length}`);
    for (const issue of issues) {
        log(formatIssue(issue, sonarProjectKey));
    }
}

async function printFailureDetails(context) {
    try {
        const details = await collectSonarDetails(context);
        printSonarDetails(details, context);
    } catch (detailsError) {
        logError(`Failed to fetch Sonar details after scan failure: ${detailsError.message}`);
    }
}

async function main() {
    const { sonarHostUrl, sonarProjectKey } = readConnectedModeConfig();
    const sonarProperties = readSonarProperties();
    const sonarToken = process.env.SONAR_TOKEN?.trim();
    const branchName = resolveBranchName();

    if (!sonarToken) {
        log('Skipping Sonar scan because SONAR_TOKEN is not set.');
        process.exit(0);
    }

    log(`Using SonarQube project "${sonarProjectKey}" from .sonarlint/connectedMode.json.`);
    log(`Running analysis for branch "${branchName}".`);

    if (sonarProperties['sonar.projectKey'] && sonarProperties['sonar.projectKey'] !== sonarProjectKey) {
        log(
            `Overriding sonar.projectKey="${sonarProperties['sonar.projectKey']}" with connected-mode project key "${sonarProjectKey}".`,
        );
    }

    if (process.env.SONAR_SKIP_TESTS?.trim()) {
        log('Skipping test run (SONAR_SKIP_TESTS is set). Using existing coverage.xml.');
    } else {
        log('Generating coverage.xml...');
        await runCommand(
            'poetry',
            ['run', 'pytest', 'tests/', '-W', 'ignore::DeprecationWarning', '--cov', '--cov-report=xml:coverage.xml'],
            { description: 'coverage generation' },
        );
    }

    const scannerCommand = resolveScannerCommand();
    log(`Running sonar-scanner against ${sonarHostUrl}.`);
    try {
        await runCommand(
            scannerCommand,
            [
                `-Dsonar.projectKey=${sonarProjectKey}`,
                `-Dsonar.branch.name=${branchName}`,
                '-Dsonar.qualitygate.wait=true',
            ],
            {
                description: 'sonar-scanner',
                env: {
                    ...process.env,
                    SONAR_HOST_URL: sonarHostUrl,
                    SONAR_TOKEN: sonarToken,
                },
            },
        );
    } catch (error) {
        await printFailureDetails({
            branchName,
            sonarHostUrl,
            sonarProjectKey,
            sonarToken,
        });
        throw error;
    }

    log('Sonar scan completed successfully.');
}

main().catch((error) => {
    logError(error.message);
    process.exit(1);
});

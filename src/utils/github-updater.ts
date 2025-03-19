import { Notice, requestUrl } from 'obsidian';
const currentVersion = '1.2.0'; // Manually set to match manifest.json

// GitHub repository info
const GITHUB_OWNER = 'ded-achtung';
const GITHUB_REPO = 'obsidian-relay-sync';

interface GithubRelease {
    tag_name: string;
    name: string;
    published_at: string;
    assets: {
        name: string;
        browser_download_url: string;
    }[];
    body: string;
}

export interface UpdateInfo {
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseUrl: string;
    downloadUrl: string;
    releaseNotes: string;
    publishedAt: string;
}

/**
 * Check for updates on GitHub
 */
export async function checkForUpdates(): Promise<UpdateInfo> {
    try {
        // Fetch the latest release from GitHub
        const response = await requestUrl({
            url: `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'ObsidianRelaySync'
            }
        });

        if (response.status !== 200) {
            throw new Error(`GitHub API returned status ${response.status}`);
        }

        const release = response.json as GithubRelease;
        const latestVersion = release.tag_name.replace('v', ''); // Remove 'v' prefix if present
        
        // Check if there's a newer version
        const isUpdateAvailable = compareVersions(latestVersion, currentVersion) > 0;

        // Find the main plugin download URL
        const mainDownloadUrl = release.assets.find(asset => 
            asset.name === 'main.js' || 
            asset.name === 'obsidian-relay-sync.zip'
        )?.browser_download_url || '';

        return {
            available: isUpdateAvailable,
            currentVersion,
            latestVersion,
            releaseUrl: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/${release.tag_name}`,
            downloadUrl: mainDownloadUrl,
            releaseNotes: release.body,
            publishedAt: release.published_at
        };
    } catch (error) {
        console.error('Error checking for updates:', error);
        throw new Error(`Не удалось проверить обновления: ${error.message}`);
    }
}

/**
 * Compare two version strings
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 */
function compareVersions(v1: string, v2: string): number {
    const v1Parts = v1.split('.').map(Number);
    const v2Parts = v2.split('.').map(Number);
    
    for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
        const v1Part = v1Parts[i] || 0;
        const v2Part = v2Parts[i] || 0;
        
        if (v1Part > v2Part) return 1;
        if (v1Part < v2Part) return -1;
    }
    
    return 0;
}

/**
 * Download and install the latest version of the plugin
 */
export async function downloadUpdate(downloadUrl: string): Promise<boolean> {
    try {
        // Download the plugin file
        const response = await requestUrl({
            url: downloadUrl,
            method: 'GET'
        });

        if (response.status !== 200) {
            throw new Error(`Ошибка при загрузке обновления. Статус: ${response.status}`);
        }

        // Extract the file content
        const fileContent = response.arrayBuffer;

        // For Obsidian, we can't directly install updates from the plugin
        // Instead, we'll open the release page and show instructions
        return true;
    } catch (error) {
        console.error('Error downloading update:', error);
        throw new Error(`Не удалось загрузить обновление: ${error.message}`);
    }
}
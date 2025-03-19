# Changelog

All notable changes to this project will be documented in this file.

## 1.2.0 (2025-03-19)

### Optimized
- Significantly improved delta-sync algorithm using LCS (Longest Common Subsequence) with compression
- Enhanced file chunking for large files to reduce memory usage
- Added intelligent file cache management with memory-based limits
- Implemented segmented state storage for large vaults to prevent localStorage limits
- Improved UI responsiveness with asynchronous batch processing of files
- Reduced memory usage during synchronization with optimized file handling
- Enhanced sync analysis with progressive non-blocking file processing
- Added support for incremental updates to improve performance with large vaults

### Added
- Standalone test suite for performance and stability testing
- Improved connection stability with automatic retries and queueing
- Enhanced synchronization algorithm with better conflict detection

## 1.1.0 (2025-03-19)

### Added
- Automatic updates system via GitHub releases
- New settings for update check frequency
- Update notification system
- Command to manually check for updates
- Detailed release notes view in updates dialog

## 1.0.1 (2025-03-17)

### Fixed
- Updated plugin ID and version for compatibility

## 1.0.0 (2025-03-16)

### Added
- First stable release ready for Obsidian Community Plugin directory
- Enhanced syncing algorithm with intelligent differential updates
- Improved conflict resolution for Markdown files
- Better error handling and reporting
- Optimized data transfer for improved efficiency
- Enhanced user interface for device pairing
- Full compatibility with all major desktop and mobile platforms

## 0.1.0 (2025-03-14)

### Added
- Initial release with core functionality
- End-to-end encrypted synchronization
- Trusted device management
- Automatic connection on startup
- Status bar indicator
- Invitation key system
- File conflict resolution based on modification time
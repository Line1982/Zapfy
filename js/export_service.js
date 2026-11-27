/**
 * Zapfy Export & Backup Service (js/export_service.js)
 * Handles JSON backup via Web Share API or download and JSON restore for settings and favorites.
 */

import { db } from './db.js?v=2.2.1';

export class ExportService {
  /**
   * Triggers native Web Share API with fallback to browser file download.
   */
  static async backupAndShare() {
    const backupData = await db.exportAllData();
    const jsonStr = JSON.stringify(backupData, null, 2);
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `zapfy_backup_${dateStr}.json`;

    const blob = new Blob([jsonStr], { type: 'application/json' });
    const file = new File([blob], fileName, { type: 'application/json' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({
          title: 'Zapfy Backup',
          text: `Zapfy Backup vom ${dateStr}`,
          files: [file]
        });
        return { success: true, method: 'share' };
      } catch (err) {
        if (err.name === 'AbortError') {
          return { success: false, cancelled: true };
        }
        console.warn('Native share failed, using fallback download:', err);
      }
    }

    this.downloadFile(blob, fileName);
    return { success: true, method: 'download' };
  }

  /**
   * Restores database from a selected JSON file.
   */
  static async restoreFromJsonFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = JSON.parse(e.target.result);
          await db.importAllData(content);
          resolve(true);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('Fehler beim Lesen der Backup-Datei.'));
      reader.readAsText(file);
    });
  }

  static downloadFile(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 1500);
  }
}

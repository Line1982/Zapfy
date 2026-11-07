/**
 * Zapfy Export & Backup Service (js/export_service.js)
 * Handles JSON backup via Web Share API or download, JSON restore, and CSV export of collected price history.
 */

import { db } from './db.js';

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
          text: `Zapfy Preis-Historie & Backup vom ${dateStr}`,
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

  /**
   * Exports all collected price snapshots as an Excel-compatible UTF-8 BOM CSV file.
   */
  static async exportSnapshotsCsv() {
    const snapshots = await db.getAllSnapshots();
    const lines = [];

    // Header
    lines.push(
      ['Datum', 'Uhrzeit (Stunde)', 'Wochentag', 'Tankstelle', 'Ort', 'Distanz (km)', 'Super E10 (€)', 'Super E5 (€)', 'Diesel (€)']
        .map(this.escapeCsv)
        .join(';')
    );

    const weekdayNames = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

    const sorted = [...snapshots].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
    for (const s of sorted) {
      const fmtNum = (val) => (typeof val === 'number' ? String(val).replace('.', ',') : '');
      lines.push(
        [
          s.date || '',
          `${String(s.hour ?? 0).padStart(2, '0')}:00`,
          weekdayNames[s.weekday] || '',
          s.station_name || '',
          s.place || '',
          fmtNum(s.dist),
          fmtNum(s.e10),
          fmtNum(s.e5),
          fmtNum(s.diesel)
        ]
          .map(this.escapeCsv)
          .join(';')
      );
    }

    const csvContent = '\uFEFF' + lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const dateStr = new Date().toISOString().slice(0, 10);
    const fileName = `Zapfy_Preishistorie_${dateStr}.csv`;

    this.downloadFile(blob, fileName);
    return sorted.length;
  }

  static escapeCsv(val) {
    let str = String(val ?? '');
    if (/^[=+\-@]/.test(str) && !/^[+-]?\d+([.,]\d+)?$/.test(str)) {
      str = `'${str}`;
    }
    if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
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

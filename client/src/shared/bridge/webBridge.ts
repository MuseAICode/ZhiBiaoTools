import type { AppBridge } from './types';

/** WebBridge 中尚未接入服务端的方法统一抛出这个错误，path 是方法在 bridge 上的路径。 */
export class BridgeNotImplementedError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`WebBridge 尚未实现：${path}`);
    this.name = 'BridgeNotImplementedError';
    this.path = path;
  }
}

// 返回 Promise 的方法用 rejected Promise 报错，与真实实现的失败方式一致；
// 同步方法（事件订阅、getPathForFile）只能同步抛出。
const notImplemented = (path: string) => (): Promise<never> => Promise.reject(new BridgeNotImplementedError(path));
const notImplementedSync = (path: string) => (): never => {
  throw new BridgeNotImplementedError(path);
};

/**
 * Web 实现的空壳：第 2 步起逐个接入服务端。
 * 用 satisfies 保证与 AppBridge 一一对应，AppBridge 增减方法时这里会类型报错。
 */
export function createWebBridge(): AppBridge {
  return {
    // 产品名称按 CLAUDE.md 命名规则在第 9 步统一确定，这里先留空。
    appName: '',
    platform: 'web',
    getVersion: notImplemented('getVersion'),
    getGpuHardwareAccelerationStatus: notImplemented('getGpuHardwareAccelerationStatus'),
    saveGpuHardwareAccelerationPreference: notImplemented('saveGpuHardwareAccelerationPreference'),
    startGpuHardwareAccelerationTrial: notImplemented('startGpuHardwareAccelerationTrial'),
    relaunchWithGpuHardwareAccelerationDisabled: notImplemented('relaunchWithGpuHardwareAccelerationDisabled'),
    requiredOnlineServices: {
      getStatus: notImplemented('requiredOnlineServices.getStatus'),
    },
    openExternal: notImplemented('openExternal'),
    database: {
      getStatus: notImplemented('database.getStatus'),
      onStatus: notImplementedSync('database.onStatus'),
    },
    ui: {
      setCurrentView: notImplemented('ui.setCurrentView'),
    },
    config: {
      load: notImplemented('config.load'),
      save: notImplemented('config.save'),
      listModels: notImplemented('config.listModels'),
      openConfigFolder: notImplemented('config.openConfigFolder'),
    },
    ai: {
      chat: notImplemented('ai.chat'),
      requestJson: notImplemented('ai.requestJson'),
      testImageModel: notImplemented('ai.testImageModel'),
      onHttpError: notImplementedSync('ai.onHttpError'),
    },
    autoConfirmation: {
      getState: notImplemented('autoConfirmation.getState'),
      setEnabled: notImplemented('autoConfirmation.setEnabled'),
      onChanged: notImplementedSync('autoConfirmation.onChanged'),
    },
    agent: {
      run: notImplemented('agent.run'),
      selfCheck: notImplemented('agent.selfCheck'),
      exportSelfCheckReport: notImplemented('agent.exportSelfCheckReport'),
      getStatus: notImplemented('agent.getStatus'),
      restart: notImplemented('agent.restart'),
      getPendingQuestion: notImplemented('agent.getPendingQuestion'),
      answerQuestion: notImplemented('agent.answerQuestion'),
      suppressQuestionAutoAnswer: notImplemented('agent.suppressQuestionAutoAnswer'),
      onStatus: notImplementedSync('agent.onStatus'),
      onQuestion: notImplementedSync('agent.onQuestion'),
    },
    developerTokenStats: {
      openWindow: notImplemented('developerTokenStats.openWindow'),
      get: notImplemented('developerTokenStats.get'),
      reset: notImplemented('developerTokenStats.reset'),
      onChanged: notImplementedSync('developerTokenStats.onChanged'),
    },
    developerAgentMonitor: {
      openWindow: notImplemented('developerAgentMonitor.openWindow'),
      openWorkspace: notImplemented('developerAgentMonitor.openWorkspace'),
      attach: notImplemented('developerAgentMonitor.attach'),
      detach: notImplemented('developerAgentMonitor.detach'),
      onEvent: notImplementedSync('developerAgentMonitor.onEvent'),
    },
    developerExpansionReplaceTest: {
      run: notImplemented('developerExpansionReplaceTest.run'),
    },
    developerLayoutFigure: {
      reset: notImplemented('developerLayoutFigure.reset'),
      render: notImplemented('developerLayoutFigure.render'),
      renderPreview: notImplemented('developerLayoutFigure.renderPreview'),
    },
    file: {
      selectDuplicateCheckFiles: notImplemented('file.selectDuplicateCheckFiles'),
      getPathForFile: notImplementedSync('file.getPathForFile'),
    },
    knowledgeBase: {
      list: notImplemented('knowledgeBase.list'),
      search: notImplemented('knowledgeBase.search'),
      createFolder: notImplemented('knowledgeBase.createFolder'),
      renameFolder: notImplemented('knowledgeBase.renameFolder'),
      reorderFolder: notImplemented('knowledgeBase.reorderFolder'),
      deleteFolder: notImplemented('knowledgeBase.deleteFolder'),
      deleteDocument: notImplemented('knowledgeBase.deleteDocument'),
      moveDocument: notImplemented('knowledgeBase.moveDocument'),
      uploadDocuments: notImplemented('knowledgeBase.uploadDocuments'),
      retryDocument: notImplemented('knowledgeBase.retryDocument'),
      startMatching: notImplemented('knowledgeBase.startMatching'),
      readMarkdown: notImplemented('knowledgeBase.readMarkdown'),
      readItems: notImplemented('knowledgeBase.readItems'),
      readAnalysis: notImplemented('knowledgeBase.readAnalysis'),
      onEvent: notImplementedSync('knowledgeBase.onEvent'),
    },
    credentialLibrary: {
      load: notImplemented('credentialLibrary.load'),
      importTestData: notImplemented('credentialLibrary.importTestData'),
      saveProfile: notImplemented('credentialLibrary.saveProfile'),
      addProfileImages: notImplemented('credentialLibrary.addProfileImages'),
      deleteImage: notImplemented('credentialLibrary.deleteImage'),
      saveCertificate: notImplemented('credentialLibrary.saveCertificate'),
      deleteCertificate: notImplemented('credentialLibrary.deleteCertificate'),
      saveEmployee: notImplemented('credentialLibrary.saveEmployee'),
      deleteEmployee: notImplemented('credentialLibrary.deleteEmployee'),
      saveProject: notImplemented('credentialLibrary.saveProject'),
      deleteProject: notImplemented('credentialLibrary.deleteProject'),
      saveOtherMaterial: notImplemented('credentialLibrary.saveOtherMaterial'),
      deleteOtherMaterial: notImplemented('credentialLibrary.deleteOtherMaterial'),
    },
    technicalPlan: {
      loadState: notImplemented('technicalPlan.loadState'),
      loadGenerationConfig: notImplemented('technicalPlan.loadGenerationConfig'),
      saveGenerationConfig: notImplemented('technicalPlan.saveGenerationConfig'),
      importTenderDocument: notImplemented('technicalPlan.importTenderDocument'),
      removeTenderDocument: notImplemented('technicalPlan.removeTenderDocument'),
      importOriginalPlanDocument: notImplemented('technicalPlan.importOriginalPlanDocument'),
      removeOriginalPlanDocument: notImplemented('technicalPlan.removeOriginalPlanDocument'),
      checkBidSections: notImplemented('technicalPlan.checkBidSections'),
      selectBidSection: notImplemented('technicalPlan.selectBidSection'),
      readTenderMarkdown: notImplemented('technicalPlan.readTenderMarkdown'),
      readContentWord: notImplemented('technicalPlan.readContentWord'),
      previewContentWord: notImplemented('technicalPlan.previewContentWord'),
      readTenderSourceMarkdown: notImplemented('technicalPlan.readTenderSourceMarkdown'),
      updateStep: notImplemented('technicalPlan.updateStep'),
      saveBidAnalysisConfig: notImplemented('technicalPlan.saveBidAnalysisConfig'),
      saveOutlineSelection: notImplemented('technicalPlan.saveOutlineSelection'),
      saveOutline: notImplemented('technicalPlan.saveOutline'),
      saveGlobalFacts: notImplemented('technicalPlan.saveGlobalFacts'),
      saveContentGenerationOptions: notImplemented('technicalPlan.saveContentGenerationOptions'),
      saveChapterContent: notImplemented('technicalPlan.saveChapterContent'),
      resetContentGeneration: notImplemented('technicalPlan.resetContentGeneration'),
      clear: notImplemented('technicalPlan.clear'),
      openBidTemplate: notImplemented('technicalPlan.openBidTemplate'),
    },
    feasibilityReport: {
      loadState: notImplemented('feasibilityReport.loadState'),
      importSourceDocuments: notImplemented('feasibilityReport.importSourceDocuments'),
      removeSourceDocument: notImplemented('feasibilityReport.removeSourceDocument'),
      readSourceMarkdown: notImplemented('feasibilityReport.readSourceMarkdown'),
      readCombinedSourceMarkdown: notImplemented('feasibilityReport.readCombinedSourceMarkdown'),
      updateStep: notImplemented('feasibilityReport.updateStep'),
      saveProjectInfo: notImplemented('feasibilityReport.saveProjectInfo'),
      saveAnalysis: notImplemented('feasibilityReport.saveAnalysis'),
      saveOutlineConfig: notImplemented('feasibilityReport.saveOutlineConfig'),
      saveOutline: notImplemented('feasibilityReport.saveOutline'),
      saveKeyParameters: notImplemented('feasibilityReport.saveKeyParameters'),
      saveChapterContent: notImplemented('feasibilityReport.saveChapterContent'),
      clear: notImplemented('feasibilityReport.clear'),
    },
    duplicateCheck: {
      loadState: notImplemented('duplicateCheck.loadState'),
      saveFiles: notImplemented('duplicateCheck.saveFiles'),
      saveUiState: notImplemented('duplicateCheck.saveUiState'),
      updateState: notImplemented('duplicateCheck.updateState'),
      clear: notImplemented('duplicateCheck.clear'),
      exportExcel: notImplemented('duplicateCheck.exportExcel'),
    },
    rejectionCheck: {
      loadState: notImplemented('rejectionCheck.loadState'),
      importDocument: notImplemented('rejectionCheck.importDocument'),
      importTenderFromTechnicalPlan: notImplemented('rejectionCheck.importTenderFromTechnicalPlan'),
      removeDocument: notImplemented('rejectionCheck.removeDocument'),
      saveUiState: notImplemented('rejectionCheck.saveUiState'),
      updateState: notImplemented('rejectionCheck.updateState'),
      exportExcel: notImplemented('rejectionCheck.exportExcel'),
      clear: notImplemented('rejectionCheck.clear'),
    },
    templates: {
      list: notImplemented('templates.list'),
      get: notImplemented('templates.get'),
      create: notImplemented('templates.create'),
      update: notImplemented('templates.update'),
      delete: notImplemented('templates.delete'),
      duplicate: notImplemented('templates.duplicate'),
      renderPreview: notImplemented('templates.renderPreview'),
    },
    tasks: {
      startBidSectionExtraction: notImplemented('tasks.startBidSectionExtraction'),
      startBidAnalysis: notImplemented('tasks.startBidAnalysis'),
      startOutlineGeneration: notImplemented('tasks.startOutlineGeneration'),
      suppressOutlineSelectionAutoConfirmation: notImplemented('tasks.suppressOutlineSelectionAutoConfirmation'),
      startGlobalFactsGeneration: notImplemented('tasks.startGlobalFactsGeneration'),
      startContentGeneration: notImplemented('tasks.startContentGeneration'),
      pauseContentGeneration: notImplemented('tasks.pauseContentGeneration'),
      startRejectionItemsExtraction: notImplemented('tasks.startRejectionItemsExtraction'),
      startRejectionCheck: notImplemented('tasks.startRejectionCheck'),
      startDuplicateAnalysis: notImplemented('tasks.startDuplicateAnalysis'),
      startFeasibilityAnalysis: notImplemented('tasks.startFeasibilityAnalysis'),
      startFeasibilityOutline: notImplemented('tasks.startFeasibilityOutline'),
      startFeasibilityParameters: notImplemented('tasks.startFeasibilityParameters'),
      startFeasibilityContent: notImplemented('tasks.startFeasibilityContent'),
      pauseFeasibilityContent: notImplemented('tasks.pauseFeasibilityContent'),
      startFeasibilityHumanWriting: notImplemented('tasks.startFeasibilityHumanWriting'),
      getActiveTasks: notImplemented('tasks.getActiveTasks'),
      onTaskEvent: notImplementedSync('tasks.onTaskEvent'),
    },
    export: {
      exportWord: notImplemented('export.exportWord'),
      openFile: notImplemented('export.openFile'),
      onWordExportProgress: notImplementedSync('export.onWordExportProgress'),
    },
    systemFonts: {
      list: notImplemented('systemFonts.list'),
    },
  } satisfies AppBridge;
}

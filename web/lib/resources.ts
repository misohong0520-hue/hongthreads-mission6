export type ResourceName = 'benchmarks' | 'drafts' | 'personas' | 'templates' | 'revenue' | 'folders' | 'sessions' | 'generations';
export type ResourceConfig = { name: ResourceName; label: string; single: string; description: string; icon: string; placeholder: string; readonly?: boolean };
export const resources: ResourceConfig[] = [
  { name: 'benchmarks', label: '벤치마킹 자료', single: '벤치마킹 자료', description: '좋은 콘텐츠와 아이디어를 모으고, 나만의 콘텐츠로 발전시켜 보세요.', icon: '▣', placeholder: '기억하고 싶은 글이나 아이디어를 적어 주세요.' },
  { name: 'drafts', label: '내 원고 보관함', single: '원고', description: '작성 중인 원고와 완성한 글을 한곳에서 관리하세요.', icon: '▤', placeholder: '저장할 원고를 작성해 주세요.' },
  { name: 'personas', label: '페르소나', single: '페르소나', description: '나만의 말투와 콘텐츠 방향을 정리해 두세요.', icon: '♧', placeholder: '말투, 독자, 콘텐츠 방향과 작성 규칙을 적어 주세요.' },
  { name: 'templates', label: '댓글·작성 양식', single: '양식', description: '자주 사용하는 문장과 댓글 양식을 편하게 꺼내 쓰세요.', icon: '≡', placeholder: '반복해서 사용할 문장이나 작성 양식을 적어 주세요.' },
  { name: 'revenue', label: '수익 증빙', single: '수익 증빙', description: '수익 기록과 관련 증빙 파일을 함께 보관하세요.', icon: '↗', placeholder: '기록할 수익 내용과 확인 사항을 적어 주세요.' },
  { name: 'folders', label: '폴더 관리', single: '폴더', description: '자료를 찾기 쉽도록 폴더를 정리하세요.', icon: '▱', placeholder: '폴더에 대한 설명을 적어 주세요.' },
  { name: 'sessions', label: '편집 세션', single: '편집 세션', description: '에디터에서 저장된 작업 기록을 확인하세요.', icon: '◷', placeholder: '', readonly: true },
  { name: 'generations', label: 'AI 생성 기록', single: '생성 기록', description: 'AI가 생성한 콘텐츠와 작업 상태를 확인하세요.', icon: '✦', placeholder: '', readonly: true },
];
export function getResource(value: string) { return resources.find(item => item.name === value); }

export type Asset = { id: string; name: string; mime_type?: string; size?: number; url?: string; status?: string };
export type RecordData = { id: string; title: string; content: string; source_url?: string; folder_id?: string | null; assets: Asset[]; status?: string; version: number; created_at: string; updated_at: string; metadata?: Record<string, unknown> };
export type SessionInfo = { csrfToken: string; connected: boolean; workspace: { id: string; kind: string }; storage: { backend: string; ready: boolean } };
export type ListData = { data: RecordData[]; total: number; page: number; limit: number };

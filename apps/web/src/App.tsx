import { useQuery } from '@tanstack/react-query';
import { callApi } from './api/client.ts';

export function App() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => callApi('health') });
  const status = health.isPending ? '连接中…' : health.isError ? '服务暂不可用' : '服务正常';

  return (
    <main>
      <h1>Between Pages</h1>
      <p>各自生活，在同一页相遇。</p>
      <p role="status">{status}</p>
    </main>
  );
}

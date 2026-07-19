import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MessageContent({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`message-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ node, ...props }) {
            void node;
            return <a {...props} target="_blank" rel="noreferrer" />;
          },
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}

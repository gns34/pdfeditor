export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  category: string;
  publishDate: string; // YYYY-MM-DD
  readTime: string;
  author: {
    name: string;
    role: string;
    avatar: string;
  };
  featured?: boolean;
  tags: string[];
  tableOfContents: { id: string; text: string }[];
  keyTakeaways: string[];
  content: string; // HTML or Markdown formatted content
}

export const categories = [
  'Todos',
  'Guias & Tutoriais',
  'Segurança & Privacidade',
  'Inteligência Artificial',
  'Produtividade',
  'Conformidade Legal'
] as const;

/**
 * Adicione os seus artigos de blog manuais aqui.
 * Exemplo de estrutura:
 *
 * {
 *   slug: 'meu-primeiro-artigo',
 *   title: 'Como Fazer Algo Incrível',
 *   description: 'Breve resumo do artigo para SEO e listagem...',
 *   category: 'Guias & Tutoriais',
 *   publishDate: '2026-10-10',
 *   readTime: '5 min de leitura',
 *   featured: true,
 *   author: {
 *     name: 'O Seu Nome',
 *     role: 'Autor / Editor',
 *     avatar: 'SN'
 *   },
 *   tags: ['PDF', 'Tutorial'],
 *   keyTakeaways: ['Ponto chave 1', 'Ponto chave 2'],
 *   tableOfContents: [{ id: 'seccao-1', text: 'Secção 1' }],
 *   content: '<p>Conteúdo do seu artigo aqui...</p>'
 * }
 */
export const blogPosts: BlogPost[] = [];

export function getPostBySlug(slug: string): BlogPost | undefined {
  return blogPosts.find(post => post.slug === slug);
}

export function getFeaturedPost(): BlogPost | undefined {
  return blogPosts.find(post => post.featured) || blogPosts[0];
}

export function getRecentPosts(count = 3, excludeSlug?: string): BlogPost[] {
  return blogPosts
    .filter(post => post.slug !== excludeSlug)
    .slice(0, count);
}

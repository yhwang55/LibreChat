import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Skeleton } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, getTokenHeader } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

type Product = {
  title?: string;
  price?: string;
  image?: string;
  link?: string;
  source?: string;
};

/**
 * 답변이 카테고리별로 구성됐을 때 백엔드가 내려주는 목록. 검색어가 곧 식별자다.
 * `token`은 이 검색어를 서버가 실제로 발급했다는 서명이며, 펼칠 때 그대로 돌려준다.
 */
type ProductCategory = {
  category: string;
  query: string;
  token?: string;
};

/**
 * `Part`가 스트리밍이 끝난 뒤에만 이 컴포넌트를 마운트하므로, 여기 도착하는 시점의
 * 텍스트는 이미 확정된 값이다. 따라서 디바운스는 "글자가 늘어나는 동안 기다리는" 용도가
 * 아니라 리마운트(StrictMode의 이중 마운트, 메시지 id가 서버 id로 바뀌는 순간 등)로
 * 같은 요청이 연달아 나가는 것을 합치는 용도다. 그 목적에는 짧은 값으로 충분하고,
 * 길게 잡으면 카드가 그만큼 늦게 뜬다.
 */
const FETCH_DEBOUNCE_MS = 350;

/**
 * 스켈레톤을 띄우기 전 대기 시간.
 *
 * 실측(로컬, 백엔드 응답 기준): 프리필터로 걸리면 ~10ms, 의도 판별까지 가서 상품이
 * 아니라고 판정되면 1.2~1.4초, 상품이 있으면 쇼핑 검색이 붙어 0.8초(캐시 히트)에서
 * 3초 이상(캐시 미스)까지 걸린다.
 *
 * 응답 시간만으로 "카드가 뜰지"를 예측할 수는 없다 — 캐시된 상품 검색이 의도 판별보다
 * 빨리 끝나기도 한다. 그래서 이 값의 목적은 결과 예측이 아니라 깜빡임 제거다.
 * 1.5초로 잡으면 빠르게 끝나는 응답(상품이 아닌 경우가 대부분 여기 속한다)은
 * 스켈레톤을 아예 거치지 않고, 느린 응답에만 스켈레톤이 뜬다. 수백 ms로 낮추면
 * 상품 얘기가 아닌 거의 모든 메시지에서 스켈레톤이 떴다가 사라진다.
 */
const SKELETON_DELAY_MS = 1500;

/** 실제 카드와 같은 개수 — 백엔드 RESULT_LIMIT과 맞춘다. */
const SKELETON_COUNT = 4;

/** 스켈레톤이 실제 카드와 정확히 같은 자리를 차지하도록 형태를 한 곳에서 관리한다. */
const ROW_CLASS = 'mt-2 flex gap-3 overflow-x-auto pb-2';
const CARD_CLASS = 'flex w-40 flex-shrink-0 flex-col rounded-lg border border-border-medium p-2';

/**
 * 이 답변을 유도한 사용자 질문. 판정 기준이 질문 성격에 따라 달라지므로
 * (구체적 추천 요청이면 느슨하게, 일반 조언 요청이면 엄격하게) 분류기에 같이 넘긴다.
 *
 * 컨텍스트로 받는 이유: 질문을 알아내려면 메시지 트리(React Query)가 필요한데,
 * 이 컴포넌트는 모든 어시스턴트 텍스트 파트마다 마운트된다. 여기서 직접
 * `useQueryClient`를 부르면 `ContentParts`를 렌더하는 모든 화면이 QueryClientProvider를
 * 강제로 요구하게 된다 — 검색 결과나 서브에이전트 패널처럼 질문 개념이 없는 곳까지.
 * 그래서 값을 가진 호스트가 넣어주고, 없으면 undefined로 남는다(백엔드가 기존
 * 동작인 SPECIFIC으로 처리).
 */
type QuestionResolver = () => string | undefined;

const ProductQuestionContext = createContext<QuestionResolver | undefined>(undefined);

/**
 * 메시지 트리를 거슬러 올라가 이 답변 바로 앞의 사용자 질문을 찾는 함수를 돌려준다.
 * 도구 호출 등으로 어시스턴트 메시지가 연달아 있을 수 있어 한 단계 위로는 부족하다.
 * 호스트(메시지 행)에서 호출한다 — 거기는 항상 QueryClientProvider 아래에 있다.
 *
 * 값이 아니라 함수를 넘기는 이유: 렌더 시점에 값을 확정하면 그때 캐시가 비어 있던
 * 경우 `undefined`로 굳는다. 의존성(messageId, conversationId)이 그대로라 캐시가
 * 나중에 채워져도 다시 계산되지 않고, 질문이 빠진 채 조용히 예전 기준으로 판정된다.
 * 호출 직전에 읽으면 그 시점의 캐시를 보게 된다.
 */
export function useProductQuestionResolver(message?: TMessage): QuestionResolver {
  const queryClient = useQueryClient();
  const messageId = message?.messageId;
  const conversationId = message?.conversationId;

  return useCallback(() => {
    if (!messageId || !conversationId) {
      return undefined;
    }
    const messages = queryClient.getQueryData<TMessage[]>([QueryKeys.messages, conversationId]);
    if (!messages?.length) {
      return undefined;
    }

    const byId = new Map(messages.map((entry) => [entry.messageId, entry]));
    let current = byId.get(messageId);

    while (current?.parentMessageId != null) {
      const parent = byId.get(current.parentMessageId);
      if (!parent) {
        return undefined;
      }
      if (parent.isCreatedByUser) {
        return parent.text?.trim() || undefined;
      }
      current = parent;
    }
    return undefined;
  }, [messageId, conversationId, queryClient]);
}

export const ProductQuestionProvider = ProductQuestionContext.Provider;

function CardRow({ products }: { products: Product[] }) {
  return (
    <div className={ROW_CLASS}>
      {products.map((product, i) => (
        <a
          key={i}
          href={product.link}
          target="_blank"
          rel="noopener noreferrer"
          className={`${CARD_CLASS} text-xs transition hover:shadow-md`}
        >
          {product.image && (
            <img
              src={product.image}
              alt={product.title}
              className="mb-2 h-24 w-full rounded object-cover"
            />
          )}
          <span className="line-clamp-2 font-medium">{product.title}</span>
          {product.price && <span className="mt-1 text-text-secondary">{product.price}</span>}
          {product.source && (
            <span className="mt-0.5 text-[10px] text-text-tertiary">{product.source}</span>
          )}
        </a>
      ))}
    </div>
  );
}

function SkeletonRow({ label }: { label: string }) {
  return (
    <div className={ROW_CLASS}>
      {/** 스켈레톤 자체는 장식이라 라이브 리전이 로딩 상태를 대신 알린다. */}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {label}
      </span>
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <div key={i} aria-hidden="true" className={CARD_CLASS}>
          <Skeleton className="mb-2 h-24 w-full rounded" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="mt-1 h-3 w-3/5" />
          <Skeleton className="mt-2 h-3 w-1/2" />
          <Skeleton className="mt-1 h-2 w-1/3" />
        </div>
      ))}
    </div>
  );
}

/**
 * 카테고리 하나의 상태. 펼치기 전에는 검색을 하지 않고, 한 번 받은 결과는 접었다
 * 펴도 다시 받지 않는다 — 펼침 한 번이 쇼핑 검색 한 번이라 재검색은 곧 예산이다.
 */
type CategoryState = {
  status: 'idle' | 'loading' | 'loaded';
  products: Product[];
};

function CategoryAccordion({
  categories,
  market,
}: {
  categories: ProductCategory[];
  market?: string;
}) {
  const localize = useLocalize();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, CategoryState>>({});
  const [slowQueries, setSlowQueries] = useState<Record<string, boolean>>({});

  const toggle = (entry: ProductCategory) => {
    const key = entry.query;
    if (expanded === key) {
      setExpanded(null);
      return;
    }
    setExpanded(key);

    /** 이미 받아둔 카테고리는 다시 검색하지 않는다. */
    if (states[key] != null) {
      return;
    }
    setStates((prev) => ({ ...prev, [key]: { status: 'loading', products: [] } }));

    const skeletonTimer = setTimeout(
      () => setSlowQueries((prev) => ({ ...prev, [key]: true })),
      SKELETON_DELAY_MS,
    );
    const settle = (products: Product[]) => {
      clearTimeout(skeletonTimer);
      setSlowQueries((prev) => ({ ...prev, [key]: false }));
      setStates((prev) => ({ ...prev, [key]: { status: 'loaded', products } }));
    };

    fetch('/api/products/category', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: getTokenHeader() ?? '',
      },
      /** 시장은 `/search`가 질문 언어로 이미 정했다. 여기서 검색어만 보고 다시
       *  추측하면 "Manduka PRO Yoga Mat"처럼 로마자뿐인 한국 시장 검색어가
       *  미국으로 넘어간다. 정해진 값을 그대로 돌려준다. */
      body: JSON.stringify({ query: entry.query, token: entry.token, market }),
    })
      .then((res) => res.json())
      .then((data) => settle(data?.products ?? []))
      .catch(() => settle([]));
  };

  return (
    <div className="mt-2 flex flex-col gap-1">
      {categories.map((entry) => {
        const key = entry.query;
        const state = states[key];
        const isOpen = expanded === key;
        const panelId = `product-category-${key.replace(/\s+/g, '-')}`;

        return (
          <div key={key} className="rounded-lg border border-border-medium">
            <button
              type="button"
              data-testid="product-category-toggle"
              onClick={() => toggle(entry)}
              aria-expanded={isOpen}
              aria-controls={panelId}
              className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
            >
              <span>{entry.category}</span>
              <ChevronDown
                aria-hidden="true"
                className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`}
              />
            </button>
            <div id={panelId} hidden={!isOpen} className="px-3 pb-2">
              {state?.status === 'loaded' && state.products.length > 0 && (
                <CardRow products={state.products} />
              )}
              {state?.status === 'loaded' && state.products.length === 0 && (
                <p className="py-2 text-xs text-text-secondary">
                  {localize('com_ui_no_results_found')}
                </p>
              )}
              {state?.status === 'loading' && slowQueries[key] === true && (
                <SkeletonRow label={localize('com_ui_loading')} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function ProductCards({ text }: { text: string }) {
  const localize = useLocalize();
  const resolveQuestion = useContext(ProductQuestionContext);
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [market, setMarket] = useState<string | undefined>(undefined);
  const [showSkeleton, setShowSkeleton] = useState(false);
  const fetchedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!text || text.trim().length < 10) {
      return;
    }

    let cancelled = false;
    let skeletonTimer: ReturnType<typeof setTimeout> | undefined;

    const fetchTimer = setTimeout(() => {
      if (fetchedForRef.current === text) {
        return;
      }
      fetchedForRef.current = text;

      skeletonTimer = setTimeout(() => {
        if (!cancelled) {
          setShowSkeleton(true);
        }
      }, SKELETON_DELAY_MS);

      const settle = (
        next: Product[],
        nextCategories: ProductCategory[] = [],
        nextMarket?: string,
      ) => {
        clearTimeout(skeletonTimer);
        if (cancelled) {
          return;
        }
        setShowSkeleton(false);
        setProducts(next);
        setCategories(nextCategories);
        setMarket(nextMarket);
      };

      fetch('/api/products/search', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          Authorization: getTokenHeader() ?? '',
        },
        /** 렌더 시점이 아니라 호출 직전에 읽어야 그 사이 채워진 메시지 트리를 본다. */
        body: JSON.stringify({ text, question: resolveQuestion?.() }),
      })
        .then((res) => res.json())
        .then((data) => settle(data?.products ?? [], data?.categories ?? [], data?.market))
        .catch(() => settle([]));
    }, FETCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(fetchTimer);
      clearTimeout(skeletonTimer);
    };
  }, [text, resolveQuestion]);

  /** 카테고리 답변은 아코디언으로, 그 외에는 기존 단일 카드 세트로 렌더한다. */
  if (categories.length > 0) {
    return <CategoryAccordion categories={categories} market={market} />;
  }

  if (products.length > 0) {
    return <CardRow products={products} />;
  }

  if (!showSkeleton) {
    return null;
  }

  return <SkeletonRow label={localize('com_ui_loading')} />;
}

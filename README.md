# Wanted Manager

원티드(`https://www.wanted.co.kr`)에서 조건에 맞는 공고 카드를 내 화면에서만 숨기는 크롬 확장 프로그램(Manifest V3)입니다.

- DOM 조작만 사용합니다.
- 네트워크 요청 차단/변조는 하지 않습니다.
- SPA 라우팅(`/wdlist*`, `/wd/{id}`)과 무한 스크롤을 지원합니다.

## 주요 기능

- 규칙 기반 공고 숨김
  - 회사명 키워드 (부분 일치, 대소문자 무시)
  - 제목 키워드 (부분 일치)
  - 공고 링크/ID
- 카드 우측 상단 `이 공고 숨기기` 버튼으로 즉시 숨김 + ID 규칙 자동 추가
- 규칙별 매칭 모드: `AND` / `OR`
- 규칙별 동작 모드: `remove(제거)` / `hide(숨김)`
- `chrome.storage.sync` 저장
- 상세 페이지 옵션(기본 OFF)
  - ON 시 `/wd/{id}`에서 매칭되면 상단 배너 표시
- 디버그 모드
  - 링크 발견 수, 카드 판정 성공률, title/company 추출 성공률 로그 출력

## 프로젝트 구조

```text
manifest.json
esbuild.config.mjs
package.json
tsconfig.json
src/
  content/index.ts
  popup/index.html
  popup/index.ts
  popup/styles.css
  shared/types.ts
  shared/storage.ts
  shared/rules.ts
  shared/selectors.ts
```

## 설치 및 빌드

1. 의존성 설치

```bash
npm i
```

2. 빌드

```bash
npm run build
```

3. Chrome에 로드
- `chrome://extensions` 접속
- 개발자 모드 ON
- "압축해제된 확장 프로그램을 로드" 클릭
- 이 프로젝트 루트 폴더 선택

## 사용 방법

1. 원티드 페이지에서 확장 팝업 열기
2. 규칙 추가
   - 회사명/제목/링크(ID) 중 하나 이상 입력
   - 매칭 방식(AND/OR) 및 동작(제거/숨김) 선택
3. `/wdlist` 페이지에서 카드가 자동으로 숨김/제거
4. 상세 페이지 옵션을 켜면 `/wd/{id}`에서도 배너 표시

## 규칙 예시

- 회사명에 `토스` 포함된 공고 전부 `hide(숨김)`
- 제목에 `인턴` 또는 `주니어` 포함된 공고 `remove(제거)` (OR)
- 특정 공고 `859` 또는 `/wd/859`를 직접 지정하여 숨김

## 유지보수 포인트

Wanted DOM이 바뀌면 우선 `src/shared/selectors.ts`만 수정해 대응하도록 설계했습니다.

- 클래스명/해시 기반 선택자는 사용하지 않음
- 링크 패턴(`/wd/{id}`) 기반으로 카드 추정
- 카드/제목/회사명 추출 휴리스틱을 모듈화

## 참고

- 자동 클릭/지원/폼 제출 기능은 포함하지 않습니다.
- 콘텐츠 구조 변경이 심한 경우 휴리스틱 튜닝이 필요할 수 있습니다.

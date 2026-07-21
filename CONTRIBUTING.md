# 기여 방법

## 버전 규칙

Life Daemon은 [유의적 버전 2.0.0](https://semver.org/lang/ko/)을 따릅니다.

- `MAJOR`: 호환되지 않는 변경
- `MINOR`: 이전 버전과 호환되는 기능 추가
- `PATCH`: 이전 버전과 호환되는 오류 수정
- 시험판: `1.2.0-alpha.1`, `1.2.0-beta.1`, `1.2.0-rc.1`

릴리스 태그는 `vMAJOR.MINOR.PATCH` 형식을 사용합니다. 예: `v1.2.3`. Git 태그와 `package.json`의 버전은 일치해야 합니다.

## 커밋 메시지

커밋은 [Conventional Commits](https://www.conventionalcommits.org/) 형식을 따릅니다.

```text
<type>(optional-scope): <imperative summary>
```

사용할 수 있는 유형:

- `feat`: 사용자에게 보이는 새 기능
- `fix`: 오류 수정
- `refactor`: 동작을 바꾸지 않는 내부 변경
- `perf`: 성능 개선
- `docs`: 문서만 변경
- `test`: 테스트만 변경
- `build`: 빌드 시스템 또는 의존성 변경
- `ci`: CI 설정 변경
- `chore`: 제품 동작을 바꾸지 않는 유지보수
- `revert`: 이전 커밋 되돌리기

예시:

```text
feat(reminders): resolve official result links at delivery time
fix(housing): exclude notices after the application deadline
docs: document production setup
```

호환되지 않는 변경에는 `!` 또는 `BREAKING CHANGE:` 바닥글을 사용합니다.

```text
feat(bot)!: replace legacy command routing

BREAKING CHANGE: custom modules must implement the new router interface.
```

## 릴리스 영향

- `feat` → `MINOR`
- `fix` 또는 `perf` → `PATCH`
- 호환되지 않는 변경 → `MAJOR`
- 그 밖의 유형은 호환되지 않는 변경이 없다면 릴리스가 필요하지 않음

각 커밋에는 하나의 논리적 변경만 담습니다. 비밀정보, 생성된 DB, 인증 파일 또는 관계없는 서식 변경을 함께 넣지 마세요.

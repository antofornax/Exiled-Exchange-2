<template>
  <div :class="[$style.btn, { [$style.active]: !filter.disabled }]">
    <button @click="filter.disabled = !filter.disabled" class="pl-2">
      {{ name }}
    </button>
    <div :class="$style.inputWrap">
      <input
        :class="$style.input"
        step="any"
        type="number"
        v-model.number="inputMin"
        @focus="inputFocus"
        @blur="inputMinBlur"
        @mousewheel.stop
        :style="{ width: `${1.2 + Math.max(String(inputMin).length, 2)}ch` }"
      />
      <span :class="$style.arrows">
        <button type="button" :class="$style.arrowBtn" @click="increment" aria-label="Increment">▲</button>
        <button type="button" :class="$style.arrowBtn" @click="decrement" aria-label="Decrement">▼</button>
      </span>
    </div>
    <template v-if="'max' in filter">
      <span>–</span>
      <input
        :class="$style.input"
        step="any"
        type="number"
        v-model.number="inputMax"
        @focus="inputFocus"
        @mousewheel.stop
        :style="{ width: `${1.2 + Math.max(String(inputMax).length, 2)}ch` }"
        placeholder="…"
      />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, PropType, computed, ref, watch } from "vue";
import { FilterNumeric } from "./interfaces";

export default defineComponent({
  emits: [], // mutates filter
  props: {
    filter: {
      type: Object as PropType<FilterNumeric>,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
  },
  setup(props) {
    const _inputMin = ref<number | "">("");
    watch(
      () => props.filter,
      (filter) => {
        _inputMin.value = filter.value;
      },
      { immediate: true },
    );

    const _inputMax = ref<number | "">("");
    watch(
      () => props.filter,
      (filter) => {
        _inputMax.value = filter.max ?? "";
      },
      { immediate: true },
    );

    return {
      inputMin: computed<number | "">({
        get() {
          return _inputMin.value;
        },
        set(value) {
          _inputMin.value = value;
          if (typeof value === "number") {
            props.filter.value = value;
          } else {
            props.filter.value = 0;
          }
        },
      }),
      inputMax: computed<number | "">({
        get() {
          return _inputMax.value;
        },
        set(value) {
          _inputMax.value = value;
          if (typeof value === "number") {
            props.filter.max = value;
          } else {
            props.filter.max = undefined;
          }
        },
      }),
      inputFocus(e: FocusEvent) {
        const target = e.target as HTMLInputElement;
        target.select();
        props.filter.disabled = false;
      },
      inputMinBlur() {
        if (typeof _inputMin.value !== "number") {
          _inputMin.value = 0;
          props.filter.disabled = true;
        }
      },
      increment() {
        const n = typeof _inputMin.value === "number" ? _inputMin.value : 0;
        const next = n + 1;
        _inputMin.value = next;
        props.filter.value = next;
        props.filter.disabled = false;
      },
      decrement() {
        const n = typeof _inputMin.value === "number" ? _inputMin.value : 0;
        const next = Math.max(0, n - 1);
        _inputMin.value = next;
        props.filter.value = next;
        props.filter.disabled = false;
      },
    };
  },
});
</script>

<style lang="postcss" module>
.btn {
  @apply bg-gray-900 rounded;
  @apply border border-transparent;
  @apply pr-1;
  line-height: 1.25rem;

  &.active {
    @apply border-gray-500;
  }
}

.inputWrap {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.arrows {
  display: inline-flex;
  flex-direction: column;
  margin-left: 1px;
}

.arrowBtn {
  @apply bg-gray-800 text-gray-400;
  line-height: 0.65rem;
  padding: 0 2px;
  font-size: 0.5rem;
  border: none;
  cursor: pointer;
  border-radius: 1px;
  user-select: none;
}

.arrowBtn:hover {
  @apply bg-gray-600 text-gray-200;
}

.arrowBtn:active {
  @apply bg-gray-500;
}

.input {
  @apply text-center;
  @apply bg-transparent;
  @apply text-gray-300;
  @apply select-all;

  &:hover,
  &:focus {
    @apply bg-gray-700;
    @apply -my-px border-t border-b border-gray-500;
  }

  &::placeholder {
    @apply text-gray-400;
  }

  &:focus {
    cursor: none;
  }
}
</style>
